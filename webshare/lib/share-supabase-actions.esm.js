// 자동 생성 파일 — 편집하지 말 것. 원본: app/share-supabase-actions.js
// 다시 만들기: node webshare/scripts/sync-share-lib.js (webshare/scripts/sync-share-lib.js 참고)

function uuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "")); }
function message(error) { return String(error?.message || error?.details || error || "Supabase request failed."); }
function result(data) { if (data?.error) throw data.error; return data?.data; }

function createSupabaseActionAdapter({ getClient, getUser, snapshot, changed }) {
    async function clientForUser() { const user = getUser(); if (!user?.id) throw new Error("Supabase is not connected."); return getClient(); }
    async function rpc(name, args) { const client = await clientForUser(); return result(await client.rpc(name, args)); }
    async function destroy(table, remoteId, baseRevision) {
        if (!uuid(remoteId)) return { error: "삭제할 공유 항목이 올바르지 않습니다." };
        const client = await clientForUser();
        const data = result(await client.from(table).delete().eq("id", remoteId).eq("revision", Number(baseRevision) || 0).select("id"));
        if (!data?.length) return { error: "다른 사용자의 변경이 있거나 삭제할 항목이 없습니다." };
        return { ok: true, revision: changed() };
    }
    async function createInvite(payload) {
        try {
            if (!uuid(payload?.calendarRemoteId)) return { error: "초대할 공유 캘린더가 올바르지 않습니다." };
            const rows = await rpc("create_calendar_invite", { p_calendar_id: payload.calendarRemoteId, p_role: payload.role === "editor" ? "editor" : "viewer" });
            const invite = Array.isArray(rows) ? rows[0] : rows;
            return invite?.token ? { token: invite.token, expiresAt: Date.parse(invite.expires_at) || 0, revision: changed() } : { error: "초대 코드를 만들지 못했습니다." };
        } catch (error) { return { error: message(error) }; }
    }
    async function respondInvite(payload, forcedResponse) {
        try {
            const token = String(payload?.token || "").trim(); if (!token) return { error: "초대 코드가 필요합니다." };
            const rows = await rpc("respond_calendar_invite", { p_token: token, p_response: forcedResponse || (payload?.response === "declined" ? "declined" : "accepted") });
            const invite = Array.isArray(rows) ? rows[0] : rows;
            return { ok: true, response: invite?.response || "accepted", calendarRemoteId: invite?.calendar_id || "", revision: Number(invite?.revision) || changed() };
        } catch (error) { return { error: message(error) }; }
    }
    async function leaveCalendar(payload) { try { if (!uuid(payload?.calendarRemoteId)) return { error: "탈퇴할 공유 캘린더가 올바르지 않습니다." }; const revision = await rpc("leave_shared_calendar_action", { p_calendar_id: payload.calendarRemoteId }); return { ok: true, revision: Number(revision) || changed() }; } catch (error) { return { error: message(error) }; } }
    async function transferCalendar(payload) { try { if (!uuid(payload?.calendarRemoteId) || !uuid(payload?.targetUserId)) return { error: "소유권 이전 대상이 올바르지 않습니다." }; const revision = await rpc("transfer_shared_calendar_owner", { p_calendar_id: payload.calendarRemoteId, p_target_user_id: payload.targetUserId, p_base_revision: Number(payload?.baseRevision) || 0 }); return { ok: true, revision: Number(revision) || changed() }; } catch (error) { return { error: message(error) }; } }
    async function deleteCalendar(payload) { try { return await destroy("shared_calendars", payload?.calendarRemoteId, payload?.baseRevision); } catch (error) { return { error: message(error) }; } }
    async function deleteResource(payload) {
        try {
            if (payload?.type === "poll") return await destroy("schedule_polls", payload.remoteId, payload.baseRevision);
            if (payload?.type !== "event") return { error: "삭제할 공유 항목 유형이 올바르지 않습니다." };
            const remote = await snapshot();
            const table = remote.events.some((item) => item.id === payload.remoteId) ? "shared_events" : (remote.busyBlocks.some((item) => item.id === payload.remoteId) ? "busy_blocks" : "");
            return table ? await destroy(table, payload.remoteId, payload.baseRevision) : { error: "삭제할 공유 항목이 없습니다." };
        } catch (error) { return { error: message(error) }; }
    }
    return { createInvite, acceptInvite: (payload) => respondInvite(payload, "accepted"), respondInvite, deleteCalendar, leaveCalendar, transferCalendar, deleteResource };
}

export { createSupabaseActionAdapter };