// 외부로 내보내는 일정은 공개 범위에 허용된 필드만 새 객체로 만든다.
// busy 는 제목·장소·내용을 빈 값으로 남기지 않고 키 자체를 만들지 않는다.

export function buildSharedEventData(source, visibility = "busy") {
    const src = source && typeof source === "object" ? source : {};
    if (visibility === "private") return null;
    const level = visibility === "title" || visibility === "full" ? visibility : "busy";
    const shared = {
        userId: String(src.userId || "local"),
        start: String(src.start || ""),
        end: String(src.end || ""),
        status: level
    };
    if (level === "title" || level === "full") shared.title = String(src.title || "");
    if (level === "full") {
        shared.location = String(src.location || "");
        shared.description = String(src.description || "");
    }
    return shared;
}

function datePart(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
}

function timePart(value) {
    return /^\d{2}:\d{2}$/.test(String(value || "")) ? String(value) : "";
}

function addMinutes(date, time, minutes) {
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = time.split(":").map(Number);
    const value = new Date(y, m - 1, d, hh, mm + minutes);
    return {
        date: `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`,
        time: `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`
    };
}

export function buildLocalEventShareRecords(event, visibility, userId = "local") {
    const source = event && typeof event === "object" ? event : {};
    if (!["busy", "title", "full"].includes(visibility)) return [];
    const picked = Array.isArray(source.dates) ? [...new Set(source.dates.map(datePart).filter(Boolean))].sort() : [];
    const startDate = datePart(source.date);
    if (!picked.length && !startDate) return [];
    const dates = picked.length ? picked : [startDate];
    const rangeEnd = picked.length ? "" : (datePart(source.endDate) || startDate);
    const startTime = timePart(source.timeStart);
    const requestedEnd = timePart(source.timeEnd);
    const allDay = !startTime;
    return dates.map((date) => {
        let endDate = rangeEnd && rangeEnd >= date ? rangeEnd : date;
        let endTime = allDay ? "23:59" : requestedEnd;
        if (!allDay && (!endTime || (endDate === date && endTime <= startTime))) {
            const next = addMinutes(date, startTime, 30);
            endDate = next.date;
            endTime = next.time;
        }
        const sharedData = buildSharedEventData({
            userId,
            start: `${date}T${allDay ? "00:00" : startTime}`,
            end: `${endDate}T${endTime}`,
            title: source.title,
            location: source.location,
            description: source.memo
        }, visibility);
        return { sourceDate: date, allDay, sharedData };
    });
}

function splitDateTime(value) {
    const [date = "", time = ""] = String(value || "").split("T");
    return { date, time };
}

export function sharedOccurrencesOn(workspace, dateStr, currentUserId = "local") {
    const w = workspace && typeof workspace === "object" ? workspace : {};
    const localIds = new Set((Array.isArray(w.events) ? w.events : []).map((item) => item.id));
    const calendars = new Map((Array.isArray(w.sharedCalendars) ? w.sharedCalendars : []).map((item) => [item.id, item]));
    const out = [];
    for (const sharedEvent of Array.isArray(w.sharedEvents) ? w.sharedEvents : []) {
        const data = sharedEvent?.sharedData;
        if (!data || data.status === "private" || sharedEvent.inviteStatus === "cancelled") continue;
        if (sharedEvent.localEventId && localIds.has(sharedEvent.localEventId)) continue;
        const calendar = calendars.get(sharedEvent.calendarId);
        if (calendar && calendar.visible === false) continue;
        const mine = sharedEvent.ownerId === currentUserId || (currentUserId === "local" && sharedEvent.ownerId === "local");
        const myResponse = mine ? null : sharedEvent.attendees?.find((item) => item.userId === currentUserId || (currentUserId === "local" && item.userId === "local"));
        if (myResponse?.status === "declined") continue;
        const start = splitDateTime(data.start);
        const end = splitDateTime(data.end);
        if (!start.date || dateStr < start.date || dateStr > (end.date || start.date)) continue;
        const allDay = sharedEvent.allDay === true;
        const title = data.status === "busy" ? "일정 있음" : (data.title || "공유 일정");
        const ev = {
            id: sharedEvent.id, title, catId: "", subId: "", timeStart: !allDay && dateStr === start.date ? start.time : "",
            timeEnd: !allDay && dateStr === (end.date || start.date) ? end.time : "", people: (sharedEvent.attendees || []).filter((item) => item.status === "accepted").map((item) => item.name).join(", "),
            memo: data.status === "full" ? (data.description || "") : "", location: data.status === "full" ? (data.location || "") : "",
            important: false, done: false, shared: true, sharedStatus: data.status, sharedColor: calendar?.color || "#6f87ad",
            sharedCalendarName: calendar?.name || "공유 일정", sharedEvent
        };
        out.push({
            kind: "shared", ev, date: dateStr,
            span: start.date !== (end.date || start.date), spanStart: dateStr === start.date, spanEnd: dateStr === (end.date || start.date)
        });
    }
    return out;
}

export function pollSlotKey(date, start, end) {
    return `${date}|${start}|${end}`;
}

export function parsePollSlotKey(value) {
    const [date = "", start = "", end = ""] = String(value || "").split("|");
    return { id: pollSlotKey(date, start, end), date, start, end };
}

function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function timeMinutes(value) {
    if (!/^\d{2}:\d{2}$/.test(value)) return -1;
    const [h, m] = value.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
    return h * 60 + m;
}

function timeText(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// 조율 후보는 항상 한 시간 단위다(00:00~01:00). 예전에 30분 단위로 만들어 둔 조율도 이 격자로
// 다시 그린다 — 화면마다 칸 길이가 달라지지 않게 하려면 저장값이 아니라 이 한 곳이 기준이어야 한다.
export const POLL_INTERVAL_MINUTES = 60;

export function buildPollSlots(poll) {
    const interval = POLL_INTERVAL_MINUTES;
    const slots = [];
    const seen = new Set();
    for (const candidate of Array.isArray(poll?.candidates) ? poll.candidates : []) {
        const date = String(candidate?.date || "");
        const start = String(candidate?.start || "");
        const end = String(candidate?.end || "");
        const startMinutes = timeMinutes(start);
        const endMinutes = timeMinutes(end);
        if (!validDate(date) || startMinutes < 0 || endMinutes <= startMinutes) continue;
        for (let minutes = startMinutes; minutes + interval <= endMinutes && slots.length < 500; minutes += interval) {
            const slot = { date, start: timeText(minutes), end: timeText(minutes + interval) };
            slot.id = pollSlotKey(slot.date, slot.start, slot.end);
            if (seen.has(slot.id)) continue;
            seen.add(slot.id);
            slots.push(slot);
        }
    }
    return slots.sort((a, b) => a.id.localeCompare(b.id));
}

// 응답은 가능·선호·불가능 세 가지. 선호는 "가능하고, 이 시간이면 더 좋다"는 뜻이라
// 가능 인원에 함께 세고(available), 몇 명이 선호했는지도 따로 센다(preferred).
export function pollSlotCounts(poll) {
    const participants = (Array.isArray(poll?.participants) ? poll.participants : []).filter((item) => item?.status !== "declined");
    const counts = {};
    for (const slot of buildPollSlots(poll)) {
        let available = 0;
        let preferred = 0;
        let responded = 0;
        for (const participant of participants) {
            const response = poll?.responses?.[participant.userId]?.[slot.id];
            if (response === "preferred") { available++; preferred++; responded++; }
            else if (response === "available") { available++; responded++; }
            else if (response === "unavailable") responded++;
        }
        counts[slot.id] = { available, preferred, responded, total: participants.length };
    }
    return counts;
}

// 가능 인원이 많은 순으로 상위 몇 개. 같으면 응답이 더 모인 쪽, 그마저 같으면 이른 시간.
export function recommendPollSlots(poll, limit = 3) {
    const counts = pollSlotCounts(poll);
    return buildPollSlots(poll)
        .map((slot) => ({ ...slot, ...(counts[slot.id] || { available: 0, preferred: 0, responded: 0, total: 0 }) }))
        .filter((slot) => slot.available > 0)
        // 선호가 많은 후보를 먼저 본다(선호 > 가능) — 같으면 가능 인원, 그다음 응답 수, 이른 시간.
        .sort((a, b) => (b.preferred - a.preferred) || (b.available - a.available) || (b.responded - a.responded) || a.id.localeCompare(b.id))
        .slice(0, limit);
}

export function recommendPollSlot(poll) {
    return recommendPollSlots(poll, 1)[0] || null;
}
