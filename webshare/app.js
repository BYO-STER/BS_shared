// 공유 일정 웹페이지 — 앱 없이도 초대받은 공유 캘린더·시간 조율·공유 일정에 응답한다.
//
// 서버 접근은 PC·모바일과 똑같다: 같은 Supabase 프로젝트, 같은 RLS 정책, 같은 스냅샷 로직
// (lib/share-supabase-sync.esm.js — PC 원본의 자동 사본). 이 페이지만의 권한은 없다.
//
// 로그인은 GoTrue 의 리디렉션 흐름을 그대로 쓴다:
//   /auth/v1/authorize?provider=google&redirect_to=<이 페이지> 로 보내고,
//   돌아올 때 주소 뒤 #access_token=…&refresh_token=… 조각을 읽어 세션으로 삼는다.
// 그래서 이 페이지를 올릴 주소가 Supabase 인증 설정의 Redirect URLs 에 등록돼 있어야 한다.

import { createSupabaseRest } from "./lib/supabase-rest.js";
import { buildPollSlots } from "./lib/shareddata.js";
import { createSupabaseSyncAdapter } from "./lib/share-supabase-sync.esm.js";
import { createSupabaseActionAdapter } from "./lib/share-supabase-actions.esm.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const SESSION_KEY = "bs-share-session";
const REFRESH_MARGIN_MS = 60000;
// 앱(PC·모바일)과 같은 표기를 쓴다 — 서버가 돌려주는 값은 영문 코드다.
const POLL_STATUS_LABEL = { draft: "초안", open: "응답 중", closed: "조율 종료", confirmed: "시간 확정" };
const RESPONSE_LABEL = { available: "가능", preferred: "선호", unavailable: "불가", "": "미응답" };

let session = loadSession();
let snapshotData = null;
let activeView = "overview";

const VIEW_META = {
    overview: { kicker: "기능 모듈 · 공유 일정", title: "공유 일정", description: "같은 캘린더를 확인하고 모임 가능한 시간을 조율한다." },
    calendars: { kicker: "공유 공간", title: "공유 캘린더", description: "참여 중인 공유 캘린더와 구성원을 확인한다." },
    polls: { kicker: "공유 공간", title: "시간 조율", description: "후보 시간에 가능한지 응답하고 모임 시간을 정한다." },
    events: { kicker: "공유 공간", title: "공유 일정", description: "확정된 일정의 시간과 참석 여부를 확인한다." }
};

const el = (id) => document.getElementById(id);

function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}

function saveSession(next) {
    session = next;
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
}

const client = createSupabaseRest({
    url: SUPABASE_URL,
    key: SUPABASE_PUBLISHABLE_KEY,
    getToken: async () => {
        if (!session?.access_token) return "";
        if (session.expires_at - REFRESH_MARGIN_MS > Date.now()) return session.access_token;
        if (!session.refresh_token) return session.access_token;
        const refreshed = await client.auth.refresh(session.refresh_token);
        if (refreshed.error || !refreshed.data?.access_token) return session.access_token;
        saveSession(sessionFrom(refreshed.data));
        return session.access_token;
    }
});

const syncAdapter = createSupabaseSyncAdapter({ getClient: async () => client, getUser: () => session?.user || null, onRevision: () => {} });
const actionAdapter = createSupabaseActionAdapter({
    getClient: async () => client,
    getUser: () => session?.user || null,
    snapshot: () => syncAdapter.snapshot(),
    changed: () => Date.now()
});

function sessionFrom(data) {
    const user = data?.user || session?.user || {};
    return {
        access_token: data?.access_token || "",
        refresh_token: data?.refresh_token || session?.refresh_token || "",
        expires_at: Date.now() + Math.max(0, Number(data?.expires_in) || 0) * 1000,
        user: { id: String(user.id || ""), email: user.email || null, name: user.user_metadata?.full_name || user.email || "나", isAnonymous: user.is_anonymous === true || user.isAnonymous === true }
    };
}

function status(message, isError) {
    el("status").textContent = message || "";
    el("status").classList.toggle("error", !!isError);
}

// ---------- 로그인 ----------

// 돌아올 주소는 늘 같은 한 형태로 만든다 — ".../webshare/" 와 ".../webshare/index.html" 은
// 서로 다른 주소라, 그냥 지금 주소를 쓰면 Supabase 인증 설정에 두 개를 등록해야 한다.
// 끝의 index.html 을 떼어 폴더 형태 하나로 통일한다.
export function redirectTarget() {
    return location.origin + location.pathname.replace(/index\.html$/, "");
}

function startSignIn() {
    location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTarget())}`;
}

async function guestEmail(name) {
    const bytes = new TextEncoder().encode(name.trim().toLocaleLowerCase("ko-KR"));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `guest-${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}@guest.bs-calendar.invalid`;
}

async function startGuestSession(name, password) {
    status("게스트 계정을 확인하는 중입니다.");
    const email = await guestEmail(name);
    let result = await client.auth.signInWithPassword(email, password);
    if (result.error) result = await client.auth.signUp(email, password, { full_name: name });
    if (result.error || !result.data?.access_token || !result.data?.user?.id) {
        status("이름 또는 비밀번호를 확인하거나 다른 이름으로 다시 시도해 주세요.", true);
        return false;
    }
    saveSession(sessionFrom(result.data));
    return true;
}

// 돌아온 주소의 조각(#…)에서 토큰을 받아 세션으로 삼는다. 조각은 히스토리에 남기지 않는다.
async function consumeRedirect() {
    if (!location.hash.includes("access_token")) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get("access_token") || "";
    if (!accessToken) return false;
    const expiresIn = Number(params.get("expires_in")) || 3600;
    saveSession({
        access_token: accessToken,
        refresh_token: params.get("refresh_token") || "",
        expires_at: Date.now() + expiresIn * 1000,
        user: { id: "", email: null, name: "나" }
    });
    history.replaceState(null, "", redirectTarget());
    const me = await client.auth.user(accessToken);
    if (!me.error && me.data?.id) {
        saveSession({ ...session, user: { id: me.data.id, email: me.data.email || null, name: me.data.user_metadata?.full_name || me.data.email || "나", isAnonymous: !!me.data.is_anonymous } });
    }
    return true;
}

function signOut() {
    saveSession(null);
    snapshotData = null;
    render();
}

// ---------- 표시 ----------

function fmtDateTime(value) {
    if (!value) return "";
    const [date, time] = String(value).split("T");
    return time ? `${date} ${time}` : date;
}

function slotLabel(slot) {
    const [date, start, end] = String(slot).split("|");
    return `${date} ${start}~${end}`;
}

function node(tag, attrs = {}, ...kids) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === "class") element.className = value;
        else if (key === "text") element.textContent = value;
        else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
        else if (value !== null && value !== undefined) element.setAttribute(key, value);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) element.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return element;
}

// 목록을 배열로 넘기는 자리가 많아 반드시 평탄화한다 — Element.append() 는 배열을 노드로
// 받지 않고 문자열로 바꿔 버려서(화면에 "[object HTMLDivElement]" 로 보인다) 그대로 넘기면 안 된다.
function section(title, id, ...kids) {
    return [node("h2", { id, text: title }), ...kids.flat(Infinity).filter(Boolean)];
}

function renderAccount() {
    const box = el("account");
    box.textContent = "";
    if (!session?.access_token) return;
    const anonymous = !!session.user?.isAnonymous;
    box.append(
        node("span", { class: "who", text: anonymous ? "임시 사용자" : (session.user?.name || session.user?.email || "") }),
        node("button", { class: "btn small", type: "button", onclick: () => { if (!anonymous || window.confirm("이 브라우저의 임시 참여 기록을 지웁니다. 다시 들어오려면 새 초대 코드가 필요합니다.")) signOut(); }, text: anonymous ? "나가기" : "로그아웃" }));
}

function applyView(scroll = false) {
    const ready = !!session?.access_token && !!snapshotData;
    const view = activeView;
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.target === view));
    const meta = VIEW_META[view];
    if (!ready) {
        el("signin-kicker").textContent = meta.kicker;
        el("welcome-title").textContent = meta.title;
        el("signin-description").textContent = `${meta.description} 게스트 이름과 비밀번호 또는 Google 계정으로 시작한다.`;
        return;
    }
    for (const id of ["calendars", "polls", "events"]) el(id).classList.toggle("hidden", view !== "overview" && view !== id);
    el("content-kicker").textContent = meta.kicker;
    el("content-title").textContent = meta.title;
    el("content-description").textContent = meta.description;
    if (scroll) el("main").scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

async function refresh() {
    if (!session?.access_token) return false;
    status("불러오는 중…");
    try {
        snapshotData = await syncAdapter.snapshot();
        status("");
        render();
        return true;
    } catch (err) {
        status(String(err?.message || err || "불러오지 못했습니다."), true);
        render();
        return false;
    }
}

function render() {
    renderAccount();
    const signedIn = !!session?.access_token;
    el("signin").classList.toggle("hidden", signedIn);
    el("btn-mobile-invite").classList.toggle("hidden", !signedIn);
    el("path-invite").classList.toggle("hidden", !signedIn);
    el("content").classList.toggle("hidden", !signedIn || !snapshotData);
    if (!signedIn || !snapshotData) { applyView(); return; }

    const myId = session.user?.id || "";

    const calendarsBox = el("calendars");
    calendarsBox.textContent = "";
    calendarsBox.append(...section("공유 캘린더", "calendars-title",
        snapshotData.calendarRows.length
            ? snapshotData.calendarRows.map((calendar) => node("div", { class: "row item" },
                node("span", { class: "dot", style: `background:${calendar.color || "#6f87ad"}` }),
                node("div", { class: "grow" },
                    node("strong", { text: calendar.name }),
                    node("span", { class: "sub", text: `참가 ${calendar.members.filter((m) => m.status === "accepted").length}명` }))))
            : [node("p", { class: "sub", text: "만들거나 초대 코드로 참가한 캘린더가 여기에 표시됩니다." })]));

    const calendarHeading = el("calendars-title");
    calendarsBox.insertBefore(node("div", { class: "panel-heading" }, calendarHeading, node("button", { class: "btn small", type: "button", onclick: openCalendarCreate, text: "+ 만들기" })), calendarsBox.firstChild);

    const pollsBox = el("polls");
    pollsBox.textContent = "";
    pollsBox.append(...section("시간 조율", "polls-title",
        snapshotData.pollRows.length ? snapshotData.pollRows.map((poll) => {
            const mine = poll.responses?.[myId] || {};
            const slots = (poll.candidates || []).length
                ? buildSlotKeys(poll)
                : [];
            return node("div", { class: "item" },
                node("div", { class: "row" },
                    node("div", { class: "grow" },
                        node("strong", { text: poll.title }),
                        node("span", { class: "sub", text: `${POLL_STATUS_LABEL[poll.status] || "초안"} · 후보 ${slots.length}개` }))),
                node("div", { class: "slots" }, slots.map((slot) => {
                    const current = mine[slot] || "";
                    return node("button", {
                        class: "slot" + (current ? " on " + current : ""), type: "button",
                        onclick: () => cycleResponse(poll, slot, current)
                    }, `${slotLabel(slot)} · ${RESPONSE_LABEL[current]}`);
                })));
        }) : node("p", { class: "sub", text: "진행 중인 시간 조율 요청이 없습니다." })));

    const eventsBox = el("events");
    eventsBox.textContent = "";
    eventsBox.append(...section("공유된 일정", "events-title",
        snapshotData.eventRows.length ? snapshotData.eventRows.map((event) => {
            const mine = event.attendees.find((item) => item.userId === myId);
            const title = event.sharedData?.status === "busy" ? "일정 있음" : (event.sharedData?.title || "공유 일정");
            return node("div", { class: "row item" },
                node("div", { class: "grow" },
                    node("strong", { text: title }),
                    node("span", { class: "sub", text: `${fmtDateTime(event.sharedData?.start)} ~ ${fmtDateTime(event.sharedData?.end)}` })),
                mine ? node("button", { class: "btn small" + (mine.status === "accepted" ? " primary" : ""), type: "button", onclick: () => respondEvent(event, "accepted"), text: "참가" }) : null,
                mine ? node("button", { class: "btn small" + (mine.status === "declined" ? " primary" : ""), type: "button", onclick: () => respondEvent(event, "declined"), text: "불참" }) : null);
        }) : node("p", { class: "sub", text: "예정된 공유 일정이 없습니다." })));
    applyView();
}

// 후보 시간 목록은 PC·모바일과 같은 파일(lib/shareddata.js 의 buildPollSlots)로 만든다 —
// 여기서 따로 계산하면 격자 규칙이 갈라져 응답이 엉뚱한 칸에 붙을 수 있다.
function buildSlotKeys(poll) {
    return buildPollSlots(poll).map((slot) => slot.id);
}

// ---------- 쓰기(내 응답만) ----------

const NEXT_RESPONSE = { "": "available", available: "preferred", preferred: "unavailable", unavailable: "" };

async function cycleResponse(poll, slotKey, current) {
    const next = NEXT_RESPONSE[current] ?? "available";
    status("저장 중…");
    // 서버의 슬롯 행 id 를 찾아야 한다 — 스냅샷의 원본 행에서 시각으로 맞춘다.
    const [date, start, end] = slotKey.split("|");
    const slots = (snapshotData.slotsByPoll.get(poll.remoteId) || []).filter((slot) => {
        const s = new Date(slot.starts_at), e = new Date(slot.ends_at);
        const text = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        const day = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
        return day === date && text(s) === start && text(e) === end;
    });
    if (!slots.length) { status("이 후보 시간을 서버에서 찾지 못했습니다.", true); return; }
    const slotId = slots[0].id;
    const result = next
        ? await client.from("poll_responses").upsert([{ poll_slot_id: slotId, user_id: session.user.id, response: next }], { onConflict: "poll_slot_id,user_id" })
        : await client.from("poll_responses").delete().eq("poll_slot_id", slotId).eq("user_id", session.user.id);
    if (result.error) { status(result.error.message, true); return; }
    await refresh();
}

async function respondEvent(event, response) {
    status("저장 중…");
    const result = await client.from("event_responses").upsert([{ event_id: event.remoteId, user_id: session.user.id, response }], { onConflict: "event_id,user_id" });
    if (result.error) { status(result.error.message, true); return; }
    await refresh();
}

function openCalendarCreate() {
    if (!session?.access_token) return;
    el("calendar-name").value = "";
    el("calendar-color").value = "#6f87ad";
    el("calendar-create-description").textContent = session.user?.isAnonymous ? "임시 계정이 소유자가 된다. 이 브라우저의 데이터를 지우거나 나가면 소유권을 복구할 수 없다." : "만든 계정이 소유자가 된다. 구성원은 생성 후 초대 코드로 참여시킨다.";
    el("calendar-create").showModal();
    window.setTimeout(() => el("calendar-name").focus(), 0);
}

async function createCalendar() {
    const name = el("calendar-name").value.trim();
    if (!name) { status("공유 캘린더 이름을 입력해 주세요.", true); el("calendar-name").focus(); return; }
    const submit = el("btn-calendar-create");
    if (submit.disabled) return;
    submit.disabled = true;
    status("공유 캘린더를 만드는 중입니다.");
    const clientId = crypto.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await syncAdapter.sync({ calendars: [{ clientId, name, color: el("calendar-color").value }] });
    if (result.error) { status(result.error, true); submit.disabled = false; return; }
    el("calendar-create").close();
    activeView = "calendars";
    if (await refresh()) status("공유 캘린더를 만들었습니다.");
    submit.disabled = false;
}

async function acceptInvite(input = el("invite-token")) {
    const token = input.value.trim();
    if (!token) { status("초대 코드를 입력해 주세요.", true); return; }
    if (!session?.access_token) { status("게스트 이름과 비밀번호를 먼저 입력해 주세요.", true); return; }
    status("참가 중…");
    const result = await actionAdapter.respondInvite({ token, response: "accepted" });
    if (result.error) { status(result.error, true); return; }
    input.value = "";
    if (el("invite").open) el("invite").close();
    await refresh();
    status("공유 캘린더에 참가했습니다.");
}

// ---------- 시작 ----------

el("btn-signin").onclick = startSignIn;
el("btn-invite").onclick = () => acceptInvite(el("invite-token"));
el("guest-invite").addEventListener("submit", async (event) => { event.preventDefault(); const name = el("guest-name").value.trim(), password = el("guest-password").value; if (!name || password.length < 6) { status("이름과 6자 이상 비밀번호를 입력해 주세요.", true); return; } if (!await startGuestSession(name, password)) return; const token = el("guest-invite-token"); if (token.value.trim()) await acceptInvite(token); else if (await refresh()) status(`${name} 게스트로 시작했습니다.`); });
el("path-invite").addEventListener("submit", (event) => { event.preventDefault(); acceptInvite(el("path-invite-token")); });
el("calendar-create-form").addEventListener("submit", (event) => { event.preventDefault(); createCalendar(); });
document.querySelectorAll("[data-close-calendar]").forEach((button) => button.addEventListener("click", () => el("calendar-create").close()));
function openInvite() { if (session?.access_token) { el("invite").showModal(); window.setTimeout(() => el("invite-token").focus(), 0); } }
const inviteDialogButton = el("btn-open-invite");
if (inviteDialogButton) inviteDialogButton.onclick = openInvite;
el("btn-mobile-invite").onclick = openInvite;
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
    activeView = button.dataset.target || "overview";
    applyView(true);
}));
el("invite-token").addEventListener("keydown", (event) => { if (event.key === "Enter") acceptInvite(); });

(async () => {
    await consumeRedirect();
    render();
    if (session?.access_token) {
        if (!session.user?.id) {
            const me = await client.auth.user(session.access_token);
            if (!me.error && me.data?.id) saveSession({ ...session, user: { id: me.data.id, email: me.data.email || null, name: me.data.user_metadata?.full_name || me.data.email || "나", isAnonymous: !!me.data.is_anonymous } });
            else { signOut(); return; }
        }
        await refresh();
    }
})();
