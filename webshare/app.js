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
import { createSupabaseSyncAdapter } from "./lib/share-supabase-sync.esm.js";
import { createSupabaseActionAdapter } from "./lib/share-supabase-actions.esm.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const SESSION_KEY = "bs-share-session";
const REFRESH_MARGIN_MS = 60000;

let session = loadSession();
let snapshotData = null;

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
        user: { id: String(user.id || ""), email: user.email || null, name: user.user_metadata?.full_name || user.email || "나" }
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
        saveSession({ ...session, user: { id: me.data.id, email: me.data.email || null, name: me.data.user_metadata?.full_name || me.data.email || "나" } });
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

function section(title, ...kids) {
    return [node("h2", { text: title }), ...kids];
}

function renderAccount() {
    const box = el("account");
    box.textContent = "";
    if (!session?.access_token) return;
    box.append(
        node("span", { class: "who", text: session.user?.email || session.user?.name || "" }),
        node("button", { class: "btn small", type: "button", onclick: signOut, text: "로그아웃" }));
}

async function refresh() {
    if (!session?.access_token) return;
    status("불러오는 중…");
    try {
        snapshotData = await syncAdapter.snapshot();
        status("");
    } catch (err) {
        status(String(err?.message || err || "불러오지 못했습니다."), true);
    }
    render();
}

function render() {
    renderAccount();
    const signedIn = !!session?.access_token;
    el("signin").classList.toggle("hidden", signedIn);
    el("invite").classList.toggle("hidden", !signedIn);
    el("content").classList.toggle("hidden", !signedIn || !snapshotData);
    if (!signedIn || !snapshotData) return;

    const myId = session.user?.id || "";

    const calendarsBox = el("calendars");
    calendarsBox.textContent = "";
    calendarsBox.append(...section("공유 캘린더",
        snapshotData.calendarRows.length
            ? snapshotData.calendarRows.map((calendar) => node("div", { class: "row item" },
                node("span", { class: "dot", style: `background:${calendar.color || "#6f87ad"}` }),
                node("div", { class: "grow" },
                    node("strong", { text: calendar.name }),
                    node("span", { class: "sub", text: `참가 ${calendar.members.filter((m) => m.status === "accepted").length}명` }))))
            : [node("p", { class: "sub", text: "초대 코드로 참가하면 여기에 나타납니다." })]));

    const pollsBox = el("polls");
    pollsBox.textContent = "";
    pollsBox.append(...section("시간 조율",
        snapshotData.pollRows.map((poll) => {
            const mine = poll.responses?.[myId] || {};
            const slots = (poll.candidates || []).length
                ? buildSlotKeys(poll)
                : [];
            return node("div", { class: "item" },
                node("div", { class: "row" },
                    node("div", { class: "grow" },
                        node("strong", { text: poll.title }),
                        node("span", { class: "sub", text: `${poll.status} · 후보 ${slots.length}개` }))),
                node("div", { class: "slots" }, slots.map((slot) => {
                    const current = mine[slot] || "";
                    return node("button", {
                        class: "slot" + (current ? " on " + current : ""), type: "button",
                        onclick: () => cycleResponse(poll, slot, current)
                    }, `${slotLabel(slot)} · ${{ available: "가능", preferred: "선호", unavailable: "불가", "": "미응답" }[current]}`);
                })));
        })));

    const eventsBox = el("events");
    eventsBox.textContent = "";
    eventsBox.append(...section("공유된 일정",
        snapshotData.eventRows.map((event) => {
            const mine = event.attendees.find((item) => item.userId === myId);
            const title = event.sharedData?.status === "busy" ? "일정 있음" : (event.sharedData?.title || "공유 일정");
            return node("div", { class: "row item" },
                node("div", { class: "grow" },
                    node("strong", { text: title }),
                    node("span", { class: "sub", text: `${fmtDateTime(event.sharedData?.start)} ~ ${fmtDateTime(event.sharedData?.end)}` })),
                mine ? node("button", { class: "btn small" + (mine.status === "accepted" ? " primary" : ""), type: "button", onclick: () => respondEvent(event, "accepted"), text: "참가" }) : null,
                mine ? node("button", { class: "btn small" + (mine.status === "declined" ? " primary" : ""), type: "button", onclick: () => respondEvent(event, "declined"), text: "불참" }) : null);
        })));
}

// 후보 시간 → 슬롯 키 목록(모바일·PC 와 같은 "날짜|시작|종료" 규칙).
function buildSlotKeys(poll) {
    const minutes = Number(poll.interval) === 60 ? 60 : 30;
    const keys = [];
    for (const candidate of poll.candidates || []) {
        const start = new Date(`${candidate.date}T${candidate.start}:00`);
        const end = new Date(`${candidate.date}T${candidate.end}:00`);
        for (let cur = start; cur.valueOf() + minutes * 60000 <= end.valueOf(); cur = new Date(cur.valueOf() + minutes * 60000)) {
            const next = new Date(cur.valueOf() + minutes * 60000);
            const text = (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
            keys.push(`${candidate.date}|${text(cur)}|${text(next)}`);
        }
    }
    return keys;
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

async function acceptInvite() {
    const token = el("invite-token").value.trim();
    if (!token) { status("초대 코드를 입력해 주세요.", true); return; }
    status("참가 중…");
    const result = await actionAdapter.respondInvite({ token, response: "accepted" });
    if (result.error) { status(result.error, true); return; }
    el("invite-token").value = "";
    await refresh();
    status("공유 캘린더에 참가했습니다.");
}

// ---------- 시작 ----------

el("btn-signin").onclick = startSignIn;
el("btn-invite").onclick = acceptInvite;
el("invite-token").addEventListener("keydown", (event) => { if (event.key === "Enter") acceptInvite(); });

(async () => {
    await consumeRedirect();
    render();
    if (session?.access_token) {
        if (!session.user?.id) {
            const me = await client.auth.user(session.access_token);
            if (!me.error && me.data?.id) saveSession({ ...session, user: { id: me.data.id, email: me.data.email || null, name: me.data.user_metadata?.full_name || me.data.email || "나" } });
            else { signOut(); return; }
        }
        await refresh();
    }
})();
