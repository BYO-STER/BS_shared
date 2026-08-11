// 자동 생성 파일 — 편집하지 말 것. 원본: app/share-supabase-sync.js
// 다시 만들기: node webshare/scripts/sync-share-lib.js (webshare/scripts/sync-share-lib.js 참고)

function text(value, max = 300) { return String(value ?? "").trim().slice(0, max); }
function uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "")); }
function localTime(value) { const date = new Date(String(value || "") + ":00"); return Number.isNaN(date.valueOf()) ? "" : date.toISOString(); }
function displayTime(value) { const date = new Date(value); if (Number.isNaN(date.valueOf())) return ""; return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }
function slotKey(start, end) { const a = displayTime(start), b = displayTime(end); return a && b ? `${a.slice(0, 10)}|${a.slice(11)}|${b.slice(11)}` : ""; }
function instantKey(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "" : date.toISOString(); }
function pollSlots(candidates, interval) { const output = [], seen = new Set(), minutes = Number(interval) === 60 ? 60 : 30; for (const candidate of Array.isArray(candidates) ? candidates : []) { const date = text(candidate?.date, 10), start = text(candidate?.start, 5), end = text(candidate?.end, 5); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) continue; const first = new Date(`${date}T${start}:00`), last = new Date(`${date}T${end}:00`); for (let current = first; current.valueOf() + minutes * 60000 <= last.valueOf(); current = new Date(current.valueOf() + minutes * 60000)) { const next = new Date(current.valueOf() + minutes * 60000), key = `${current.toISOString()}|${next.toISOString()}`; if (!seen.has(key)) { seen.add(key); output.push({ starts_at: current.toISOString(), ends_at: next.toISOString(), position: output.length }); } } } return output; }
function pollCandidates(slots) { return (slots || []).map((slot) => { const start = displayTime(slot.starts_at), end = displayTime(slot.ends_at); return start && end ? { date: start.slice(0, 10), start: start.slice(11), end: end.slice(11) } : null; }).filter(Boolean); }
function audienceUsers(item, calendar, ownerId, key) { const selected = (Array.isArray(item?.[key]) ? item[key] : []).map((entry) => String(entry?.userId || "")).filter(uuid); if (item?.audienceMode !== "calendar") return [...new Set([ownerId, ...selected])]; return [...new Set([ownerId, ...(calendar?.members || []).filter((member) => member.status === "accepted").map((member) => member.userId).filter(uuid)])]; }
function error(result) { if (result?.error) throw result.error; return result?.data || []; }
async function rows(client, table, columns = "*") { return error(await client.from(table).select(columns)); }
async function remove(client, table, column, values, scope = {}) { if (!values.length) return; let request = client.from(table).delete(); for (const [key, value] of Object.entries(scope)) request = request.eq(key, value); error(await request.in(column, values)); }
function profileMap(profiles) { return new Map(profiles.map((profile) => [profile.id, { name: profile.display_name || profile.email || "", email: profile.email || "" }])); }
function revision(rows) { return rows.reduce((value, row) => Math.max(value, Date.parse(row.updated_at || row.created_at || 0) || 0), 0); }

async function snapshot(client) {
    const [calendars, members, profiles, polls, slots, pollParticipants, pollResponses, events, busyBlocks, eventParticipants, busyParticipants, eventResponses] = await Promise.all([
        rows(client, "shared_calendars"), rows(client, "calendar_members"), rows(client, "profiles", "id,email,display_name,avatar_url"), rows(client, "schedule_polls"), rows(client, "poll_slots"), rows(client, "poll_participants"), rows(client, "poll_responses"), rows(client, "shared_events"), rows(client, "busy_blocks"), rows(client, "event_participants"), rows(client, "busy_block_participants"), rows(client, "event_responses")
    ]);
    const people = profileMap(profiles), membersByCalendar = new Map(), slotsByPoll = new Map(), participantsByPoll = new Map(), responsesBySlot = new Map(), participantsByEvent = new Map(), participantsByBusy = new Map(), responsesByEvent = new Map();
    for (const member of members) { const list = membersByCalendar.get(member.calendar_id) || []; list.push({ userId: member.user_id, role: member.role, status: member.status, name: people.get(member.user_id)?.name || "", email: people.get(member.user_id)?.email || "" }); membersByCalendar.set(member.calendar_id, list); }
    for (const slot of slots) { const list = slotsByPoll.get(slot.poll_id) || []; list.push(slot); slotsByPoll.set(slot.poll_id, list); }
    for (const participant of pollParticipants) { const list = participantsByPoll.get(participant.poll_id) || []; list.push({ userId: participant.user_id, status: participant.status, name: people.get(participant.user_id)?.name || "" }); participantsByPoll.set(participant.poll_id, list); }
    for (const response of pollResponses) { const list = responsesBySlot.get(response.poll_slot_id) || []; list.push(response); responsesBySlot.set(response.poll_slot_id, list); }
    for (const participant of eventParticipants) { const list = participantsByEvent.get(participant.event_id) || []; list.push(participant.user_id); participantsByEvent.set(participant.event_id, list); }
    for (const participant of busyParticipants) { const list = participantsByBusy.get(participant.busy_block_id) || []; list.push(participant.user_id); participantsByBusy.set(participant.busy_block_id, list); }
    for (const response of eventResponses) { const list = responsesByEvent.get(response.event_id) || []; list.push(response); responsesByEvent.set(response.event_id, list); }
    const calendarRows = calendars.map((calendar) => ({ remoteId: calendar.id, remoteRevision: calendar.revision, ownerId: calendar.owner_id, name: calendar.name, color: calendar.color, members: membersByCalendar.get(calendar.id) || [], updatedAt: calendar.updated_at }));
    const pollRows = polls.map((poll) => { const pollSlots = slotsByPoll.get(poll.id) || [], responses = {}; for (const slot of pollSlots) for (const item of responsesBySlot.get(slot.id) || []) { const key = slotKey(slot.starts_at, slot.ends_at); if (key) (responses[item.user_id] ||= {})[key] = item.response; } return { remoteId: poll.id, remoteRevision: poll.revision, calendarRemoteId: poll.calendar_id, ownerId: poll.created_by, title: poll.title, candidates: pollCandidates(pollSlots), interval: poll.interval_minutes, status: poll.status, audienceMode: poll.audience, displayStart: minuteText(poll.display_start_minutes), displayEnd: minuteText(poll.display_end_minutes), confirmedSlot: slotKey((pollSlots.find((slot) => slot.id === poll.confirmed_slot_id) || {}).starts_at, (pollSlots.find((slot) => slot.id === poll.confirmed_slot_id) || {}).ends_at), participants: participantsByPoll.get(poll.id) || [], responses, createdAt: poll.created_at, updatedAt: poll.updated_at }; });
    const eventRows = events.map((event) => ({ row: event, busy: false })).concat(busyBlocks.map((row) => ({ row, busy: true }))).map(({ row, busy }) => { const ids = busy ? participantsByBusy.get(row.id) || [] : participantsByEvent.get(row.id) || [], responses = busy ? [] : responsesByEvent.get(row.id) || []; const attendees = ids.map((userId) => ({ userId, name: people.get(userId)?.name || "", status: responses.find((item) => item.user_id === userId)?.response || (userId === row.created_by ? "accepted" : "pending") })); if (!attendees.some((item) => item.userId === row.created_by)) attendees.unshift({ userId: row.created_by, name: people.get(row.created_by)?.name || "", status: "accepted" }); return { remoteId: row.id, remoteRevision: row.revision, calendarRemoteId: row.calendar_id, ownerId: row.created_by, sourcePollId: busy ? "" : row.source_poll_id || "", sourceDate: "", allDay: !!row.all_day, audienceMode: row.audience, sharedData: { userId: row.created_by, start: displayTime(row.starts_at), end: displayTime(row.ends_at), status: busy ? "busy" : row.visibility, ...(busy || row.visibility === "title" || row.visibility === "full" ? {} : {}), ...(!busy && (row.visibility === "title" || row.visibility === "full") ? { title: row.title || "" } : {}), ...(!busy && row.visibility === "full" ? { location: row.location || "", description: row.description || "" } : {}) }, attendees, inviteStatus: "sent", createdAt: row.created_at, updatedAt: row.updated_at }; });
    return { calendars, members, membersByCalendar, polls, slots, slotsByPoll, pollParticipants, pollResponses, events, busyBlocks, eventParticipants, busyParticipants, eventResponses, calendarRows, pollRows, eventRows, revision: revision(calendars.concat(polls, events, busyBlocks)) };
}

async function writeCalendar(client, item, userId, remote, idMap, conflicts) {
    const baseRevision = Number(item?.baseRevision) || 0; let row = item?.remoteId ? remote.calendars.find((value) => value.id === item.remoteId) : remote.calendars.find((value) => value.owner_id === userId && value.client_id === item?.clientId);
    if (row && item?.remoteId && baseRevision !== Number(row.revision)) { conflicts.push({ type: "calendar", remoteId: row.id }); return row; }
    if (!row) row = error(await client.rpc("create_shared_calendar_action", { p_client_id: text(item?.clientId, 160) || null, p_name: text(item?.name, 120) || "Shared calendar", p_color: /^#[0-9a-f]{6}$/i.test(item?.color) ? item.color : "#6b8afd" }));
    else if (row.owner_id === userId || (remote.membersByCalendar.get(row.id) || []).some((member) => member.userId === userId && member.role === "editor" && member.status === "accepted")) row = error(await client.from("shared_calendars").update({ name: text(item?.name, 120) || row.name, color: /^#[0-9a-f]{6}$/i.test(item?.color) ? item.color : row.color }).eq("id", row.id).eq("revision", row.revision).select().maybeSingle()) || row;
    if (item?.clientId) idMap.calendars[item.clientId] = row.id;
    return row;
}

async function syncMembers(client, item, calendar, userId) {
    const editable = calendar.owner_id === userId; if (!editable) return;
    const wanted = new Map(); for (const member of Array.isArray(item?.memberUpdates) ? item.memberUpdates : []) if (uuid(member?.userId) && member.userId !== calendar.owner_id) wanted.set(member.userId, { calendar_id: calendar.id, user_id: member.userId, role: member.role === "editor" ? "editor" : "viewer", status: ["accepted", "declined"].includes(member.status) ? member.status : "pending", invited_by: userId });
    if (wanted.size) error(await client.from("calendar_members").upsert([...wanted.values()], { onConflict: "calendar_id,user_id" }));
    const removeIds = (Array.isArray(item?.memberRemovals) ? item.memberRemovals : []).filter((value) => uuid(value) && value !== calendar.owner_id); if (removeIds.length) error(await client.from("calendar_members").delete().eq("calendar_id", calendar.id).in("user_id", removeIds));
}

// 표시 범위("HH:MM")를 자정 기준 분으로. 값이 없거나 뒤집혀 있으면 하루 전체로 둔다
// (서버의 display_range 체크 제약과 같은 규칙 — 어긋나면 저장 자체가 거부된다).
function displayRangeColumns(item) {
    const toMinutes = (value, fallback) => {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
        if (!match) return fallback;
        const minutes = Number(match[1]) * 60 + Number(match[2]);
        return minutes >= 0 && minutes <= 1440 ? minutes : fallback;
    };
    const start = Math.min(1439, toMinutes(item?.displayStart, 0));
    const end = toMinutes(item?.displayEnd, 1440);
    return { display_start_minutes: start, display_end_minutes: end > start ? Math.min(1440, end) : 1440 };
}

function minuteText(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) return "00:00";
    if (value >= 1440) return "24:00";
    return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

async function writePoll(client, item, calendar, userId, remote, idMap, conflicts) {
    if (!calendar) return null; const editable = calendar.owner_id === userId || (remote.membersByCalendar.get(calendar.id) || []).some((member) => member.userId === userId && member.role === "editor" && member.status === "accepted"); let row = item?.remoteId ? remote.polls.find((value) => value.id === item.remoteId) : remote.polls.find((value) => value.calendar_id === calendar.id && value.client_id === item?.clientId);
    if (row && Number(item?.baseRevision) !== Number(row.revision) && editable) { conflicts.push({ type: "poll", remoteId: row.id }); return row; }
    if (!row && editable) row = error(await client.from("schedule_polls").insert({ calendar_id: calendar.id, client_id: text(item?.clientId, 160) || null, created_by: userId, title: text(item?.title, 160) || "Time poll", status: ["draft", "open", "confirmed", "closed"].includes(item?.status) ? item.status : "draft", interval_minutes: Number(item?.interval) === 60 ? 60 : 30, audience: item?.audienceMode === "calendar" ? "calendar" : "selected", ...displayRangeColumns(item) }).select().single());
    else if (row && editable) row = error(await client.from("schedule_polls").update({ title: text(item?.title, 160) || row.title, status: ["draft", "open", "confirmed", "closed"].includes(item?.status) ? item.status : row.status, interval_minutes: Number(item?.interval) === 60 ? 60 : 30, audience: item?.audienceMode === "calendar" ? "calendar" : "selected", ...displayRangeColumns(item) }).eq("id", row.id).eq("revision", row.revision).select().maybeSingle()) || row;
    if (!row) return null; if (item?.clientId) idMap.polls[item.clientId] = row.id;
    if (!editable) return row;
    const desired = pollSlots(item?.candidates, item?.interval), existing = remote.slotsByPoll.get(row.id) || [], existingByKey = new Map(existing.map((slot) => [`${instantKey(slot.starts_at)}|${instantKey(slot.ends_at)}`, slot])); const inserts = desired.filter((slot) => !existingByKey.has(`${slot.starts_at}|${slot.ends_at}`)).map((slot) => ({ ...slot, poll_id: row.id })); const removeIds = existing.filter((slot) => !desired.some((next) => next.starts_at === instantKey(slot.starts_at) && next.ends_at === instantKey(slot.ends_at))).map((slot) => slot.id); if (removeIds.length) await remove(client, "poll_slots", "id", removeIds); if (inserts.length) error(await client.from("poll_slots").insert(inserts));
    const currentSlots = await rows(client, "poll_slots"); const pollSlotRows = currentSlots.filter((slot) => slot.poll_id === row.id), confirmed = pollSlotRows.find((slot) => slotKey(slot.starts_at, slot.ends_at) === item?.confirmedSlot) || null; if ((confirmed?.id || null) !== (row.confirmed_slot_id || null)) row = error(await client.from("schedule_polls").update({ confirmed_slot_id: confirmed?.id || null }).eq("id", row.id).select().single());
    const users = audienceUsers(item, { members: remote.membersByCalendar.get(calendar.id) || [] }, row.created_by, "participants"), participantRows = users.map((userId) => ({ poll_id: row.id, user_id: userId, status: (Array.isArray(item?.participants) ? item.participants : []).find((value) => value?.userId === userId)?.status === "declined" ? "declined" : "accepted" })); if (participantRows.length) error(await client.from("poll_participants").upsert(participantRows, { onConflict: "poll_id,user_id" })); await remove(client, "poll_participants", "user_id", (await rows(client, "poll_participants")).filter((value) => value.poll_id === row.id && !users.includes(value.user_id)).map((value) => value.user_id), { poll_id: row.id });
    const mine = item?.responses?.[userId] || {}, responseRows = (await rows(client, "poll_responses")).filter((value) => value.user_id === userId && pollSlotRows.some((slot) => slot.id === value.poll_slot_id)), allowed = new Map(pollSlotRows.map((slot) => [slotKey(slot.starts_at, slot.ends_at), slot.id])), responseValues = Object.entries(mine).filter(([key, value]) => allowed.has(key) && ["available", "preferred", "unavailable"].includes(value)).map(([key, response]) => ({ poll_slot_id: allowed.get(key), user_id: userId, response })); await remove(client, "poll_responses", "poll_slot_id", responseRows.filter((value) => !responseValues.some((next) => next.poll_slot_id === value.poll_slot_id)).map((value) => value.poll_slot_id)); if (responseValues.length) error(await client.from("poll_responses").upsert(responseValues, { onConflict: "poll_slot_id,user_id" }));
    return row;
}

async function writeEvent(client, item, calendar, userId, remote, idMap, conflicts) {
    if (!calendar || !item?.sharedData) return null; const data = item.sharedData, busy = data.status !== "title" && data.status !== "full", table = busy ? "busy_blocks" : "shared_events", otherTable = busy ? "shared_events" : "busy_blocks", editable = calendar.owner_id === userId || (remote.membersByCalendar.get(calendar.id) || []).some((member) => member.userId === userId && member.role === "editor" && member.status === "accepted"); let row = item?.remoteId ? (busy ? remote.busyBlocks : remote.events).find((value) => value.id === item.remoteId) : (busy ? remote.busyBlocks : remote.events).find((value) => value.calendar_id === calendar.id && value.client_id === item?.clientId);
    if (!row && item?.remoteId && editable) await client.from(otherTable).delete().eq("id", item.remoteId);
    if (row && Number(item?.baseRevision) !== Number(row.revision) && editable) { conflicts.push({ type: "event", remoteId: row.id }); return row; }
    const base = { calendar_id: calendar.id, client_id: text(item?.clientId, 160) || null, local_event_id: text(item?.localEventId, 160) || null, created_by: userId, audience: item?.audienceMode === "calendar" ? "calendar" : "selected", starts_at: localTime(data.start), ends_at: localTime(data.end), all_day: !!item?.allDay };
    if (!base.starts_at || !base.ends_at) return null; const values = busy ? base : { ...base, source_poll_id: uuid(item?.sourcePollRemoteId) ? item.sourcePollRemoteId : null, visibility: data.status, title: text(data.title, 500), location: text(data.location, 500) || null, description: text(data.description, 4000) || null };
    if (!row && editable) row = error(await client.from(table).insert(values).select().single()); else if (row && editable) row = error(await client.from(table).update(values).eq("id", row.id).eq("revision", row.revision).select().maybeSingle()) || row;
    if (!row) return null; if (item?.clientId) idMap.events[item.clientId] = row.id;
    if (!editable) return row; const users = audienceUsers(item, { members: remote.membersByCalendar.get(calendar.id) || [] }, row.created_by, "attendees"), participantTable = busy ? "busy_block_participants" : "event_participants", idColumn = busy ? "busy_block_id" : "event_id", participantRows = users.map((value) => ({ [idColumn]: row.id, user_id: value })); if (participantRows.length) error(await client.from(participantTable).upsert(participantRows, { onConflict: `${idColumn},user_id` })); const existingParticipants = await rows(client, participantTable); await remove(client, participantTable, "user_id", existingParticipants.filter((value) => value[idColumn] === row.id && !users.includes(value.user_id)).map((value) => value.user_id), { [idColumn]: row.id }); if (!busy) { const mine = (Array.isArray(item?.attendees) ? item.attendees : []).find((value) => value?.userId === userId); if (mine && ["pending", "accepted", "declined"].includes(mine.status)) error(await client.from("event_responses").upsert({ event_id: row.id, user_id: userId, response: mine.status }, { onConflict: "event_id,user_id" })); }
    return row;
}

function snapshotSignature(value) {
    const tables = [value.calendars, value.members, value.polls, value.slots, value.pollParticipants, value.pollResponses, value.events, value.busyBlocks, value.eventParticipants, value.busyParticipants, value.eventResponses];
    return JSON.stringify(tables.map((rows) => rows.map((row) => Object.keys(row).sort().reduce((out, key) => ({ ...out, [key]: row[key] }), {})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
}

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function createSupabaseSyncAdapter({ getClient, getUser, onRevision }) {
    let currentRevision = 0;
    function setRevision(value) { currentRevision = Math.max(currentRevision, Number(value) || 0); onRevision?.(currentRevision); return currentRevision; }
    async function syncNow(payload) {
        const client = await getClient(), user = getUser(); if (!user?.id) return { error: "Supabase is not connected.", unauthorized: true }; const idMap = { calendars: {}, polls: {}, events: {} }, conflicts = [], initial = await snapshot(client), calendars = new Map();
        for (const item of Array.isArray(payload?.calendars) ? payload.calendars : []) { const row = await writeCalendar(client, item, user.id, initial, idMap, conflicts); if (row) { calendars.set(item?.clientId, row); await syncMembers(client, item, row, user.id); } }
        const afterCalendars = await snapshot(client); for (const item of Array.isArray(payload?.polls) ? payload.polls : []) { const calendar = afterCalendars.calendars.find((row) => row.id === item?.calendarRemoteId) || calendars.get(item?.calendarClientId); await writePoll(client, item, calendar, user.id, afterCalendars, idMap, conflicts); }
        const afterPolls = await snapshot(client); for (const item of Array.isArray(payload?.events) ? payload.events : []) { const calendar = afterPolls.calendars.find((row) => row.id === item?.calendarRemoteId) || calendars.get(item?.calendarClientId); await writeEvent(client, item, calendar, user.id, afterPolls, idMap, conflicts); }
        const final = await snapshot(client); return { idMap, conflicts, calendars: final.calendarRows, polls: final.pollRows, events: final.eventRows, revision: setRevision(final.revision), syncedAt: Date.now() };
    }
    async function sync(payload) { try { return await syncNow(payload); } catch (err) { return { error: String(err?.message || err || "Supabase sync failed.") }; } }
    async function waitChanges(payload) {
        try {
            const client = await getClient(); if (!getUser()?.id) return { error: "Supabase is not connected.", unauthorized: true };
            let signature = snapshotSignature(await snapshot(client));
            for (let attempt = 0; attempt < 30; attempt++) {
                await pause(1000);
                const next = await snapshot(client), nextSignature = snapshotSignature(next);
                if (nextSignature !== signature) return { changed: true, revision: setRevision(Math.max(Date.now(), Number(payload?.since) + 1)) };
                signature = nextSignature;
            }
            return { changed: false, revision: setRevision(Number(payload?.since) || currentRevision) };
        } catch (err) { return { error: String(err?.message || err || "Supabase change check failed.") }; }
    }
    return { sync, waitChanges, snapshot: () => getClient().then(snapshot), markChanged: () => setRevision(Date.now()) };
}

export { createSupabaseSyncAdapter };