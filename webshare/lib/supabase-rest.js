// Supabase(PostgREST + GoTrue)를 fetch 로만 다루는 얇은 클라이언트.
//
// 왜 supabase-js 를 안 쓰는가 — 이 프로젝트(모바일 www, 공유 웹페이지)는 번들러가 없고 CSP 가
// 'self' 기준이라 수백 KB 라이브러리를 동거시키는 비용이 크다. 반대로 PC 가 쓰는 동기화 로직
// (app/share-supabase-sync.js, share-supabase-actions.js)이 실제로 부르는 supabase-js API 는
// 아래 몇 가지뿐이라, 그 표면만 그대로 흉내 내면 **그 파일을 고치지 않고 그대로 재사용**할 수 있다.
// 서버 병합 규칙이 PC·모바일·웹에서 한 벌로 유지되는 게 이 방식의 핵심 이득이다.
//
//   from(table).select(columns)                     → GET    /rest/v1/{table}?select=…
//   from(table).insert(values).select().single()     → POST   (Prefer: return=representation)
//   from(table).update(values).eq(…).select().maybeSingle() → PATCH
//   from(table).upsert(rows, { onConflict })         → POST   (Prefer: resolution=merge-duplicates)
//   from(table).delete().eq(…).in(col, values)       → DELETE
//   rpc(name, params)                               → POST   /rest/v1/rpc/{name}
//
// 반환 형태도 supabase-js 와 같게 `{ data, error }` 로 맞춘다(그 파일들의 error() 헬퍼가
// result.error 를 던지고 result.data 를 꺼내 쓴다). await 하면 실행되는 thenable 이다.

const JSON_HEADERS = { "Content-Type": "application/json" };

function restError(message, status) {
    return { message: String(message || "Supabase 요청에 실패했습니다."), status: status || 0 };
}

// PostgREST 의 in.(...) 값 인용 — 콤마·따옴표가 든 값이 필터를 깨뜨리지 않게 감싼다.
function quoteInValue(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

class RestQuery {
    constructor(runner, table) {
        this.runner = runner;
        this.table = table;
        this.method = "GET";
        this.columns = "*";
        this.body = null;
        this.filters = [];
        this.params = new URLSearchParams();
        this.wantsRepresentation = false;
        this.rowMode = "many";        // many | single | maybeSingle
        this.prefer = [];
    }

    select(columns) {
        if (this.method === "GET") this.columns = columns || "*";
        else this.wantsRepresentation = true;      // insert/update/upsert 뒤에 붙는 .select()
        return this;
    }

    insert(values) {
        this.method = "POST";
        this.body = values;
        return this;
    }

    update(values) {
        this.method = "PATCH";
        this.body = values;
        return this;
    }

    upsert(values, options = {}) {
        this.method = "POST";
        this.body = values;
        this.prefer.push("resolution=merge-duplicates");
        this.wantsRepresentation = true;
        if (options.onConflict) this.params.set("on_conflict", options.onConflict);
        return this;
    }

    delete() {
        this.method = "DELETE";
        return this;
    }

    eq(column, value) {
        this.filters.push([column, value === null ? "is.null" : `eq.${value}`]);
        return this;
    }

    in(column, values) {
        this.filters.push([column, `in.(${(values || []).map(quoteInValue).join(",")})`]);
        return this;
    }

    single() {
        this.rowMode = "single";
        this.wantsRepresentation = true;
        return this;
    }

    maybeSingle() {
        this.rowMode = "maybeSingle";
        this.wantsRepresentation = true;
        return this;
    }

    buildPath() {
        const params = new URLSearchParams(this.params);
        if (this.method === "GET") params.set("select", this.columns);
        for (const [column, filter] of this.filters) params.append(column, filter);
        const query = params.toString();
        return `/rest/v1/${encodeURIComponent(this.table)}${query ? "?" + query : ""}`;
    }

    buildPrefer() {
        const prefer = [...this.prefer];
        if (this.wantsRepresentation || this.method === "GET") {
            if (this.method !== "GET") prefer.push("return=representation");
        } else if (this.method !== "GET") {
            prefer.push("return=minimal");
        }
        return prefer.join(",");
    }

    // await 하는 순간 실제 요청이 나간다(supabase-js 의 쿼리 빌더와 같은 사용감).
    then(onFulfilled, onRejected) {
        return this.runner({
            method: this.method,
            path: this.buildPath(),
            body: this.body,
            prefer: this.buildPrefer(),
            rowMode: this.rowMode
        }).then(onFulfilled, onRejected);
    }
}

// getToken() 은 지금 쓸 액세스 토큰을 돌려준다(없으면 빈 문자열 — 그때는 익명 요청이 되고
// RLS 가 막는다). 토큰 갱신은 이 파일이 아니라 호출부(세션 관리)가 맡는다.
export function createSupabaseRest({ url, key, getToken, timeoutMs = 15000 }) {
    const base = String(url || "").replace(/\/$/, "");

    async function request({ method, path, body, prefer, rowMode }) {
        if (!base || !key) return { data: null, error: restError("Supabase 주소 또는 키가 설정되지 않았습니다.") };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const token = (await getToken?.()) || "";
            const headers = { ...JSON_HEADERS, apikey: key };
            if (token) headers.Authorization = "Bearer " + token;
            if (prefer) headers.Prefer = prefer;
            const response = await fetch(base + path, {
                method,
                headers,
                body: body === null || body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });
            const raw = await response.text();
            let parsed = null;
            if (raw) {
                try { parsed = JSON.parse(raw); } catch { parsed = null; }
            }
            if (!response.ok) {
                return { data: null, error: restError(parsed?.message || parsed?.error || `HTTP ${response.status}`, response.status) };
            }
            const list = Array.isArray(parsed) ? parsed : (parsed === null ? [] : [parsed]);
            if (rowMode === "single") {
                if (list.length !== 1) return { data: null, error: restError("행이 정확히 하나가 아닙니다.", response.status) };
                return { data: list[0], error: null };
            }
            if (rowMode === "maybeSingle") {
                if (list.length > 1) return { data: null, error: restError("행이 하나보다 많습니다.", response.status) };
                return { data: list[0] ?? null, error: null };
            }
            return { data: list, error: null };
        } catch (err) {
            const aborted = err?.name === "AbortError";
            return { data: null, error: restError(aborted ? "Supabase 응답 시간이 초과되었습니다." : (err?.message || err)) };
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        from: (table) => new RestQuery(request, table),
        rpc: (name, params) => request({
            method: "POST",
            path: `/rest/v1/rpc/${encodeURIComponent(name)}`,
            body: params || {},
            prefer: "",
            rowMode: "many"
        }).then((result) => (result.error ? result : { data: Array.isArray(result.data) && result.data.length === 1 ? result.data[0] : result.data, error: null })),
        // 세션 관리(로그인·갱신)는 GoTrue 쪽이라 경로가 다르다 — 같은 fetch 규칙을 쓰되
        // apikey 만 붙이고 Authorization 은 붙이지 않는다.
        auth: {
            // 구글 id_token 을 Supabase 세션으로 교환한다(PC 의 signInWithIdToken 과 같은 동작).
            signInWithGoogleIdToken: (idToken) => authRequest(base, key, "/auth/v1/token?grant_type=id_token", { provider: "google", id_token: idToken }, timeoutMs),
            refresh: (refreshToken) => authRequest(base, key, "/auth/v1/token?grant_type=refresh_token", { refresh_token: refreshToken }, timeoutMs),
            user: async (accessToken) => {
                const result = await authRequest(base, key, "/auth/v1/user", null, timeoutMs, accessToken);
                return result;
            }
        }
    };
}

async function authRequest(base, key, path, body, timeoutMs, accessToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = { ...JSON_HEADERS, apikey: key };
        if (accessToken) headers.Authorization = "Bearer " + accessToken;
        const response = await fetch(base + path, {
            method: body === null || body === undefined ? "GET" : "POST",
            headers,
            body: body === null || body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal
        });
        const raw = await response.text();
        let parsed = null;
        if (raw) {
            try { parsed = JSON.parse(raw); } catch { parsed = null; }
        }
        if (!response.ok) {
            return { data: null, error: restError(parsed?.error_description || parsed?.msg || parsed?.message || `HTTP ${response.status}`, response.status) };
        }
        return { data: parsed, error: null };
    } catch (err) {
        const aborted = err?.name === "AbortError";
        return { data: null, error: restError(aborted ? "Supabase 응답 시간이 초과되었습니다." : (err?.message || err)) };
    } finally {
        clearTimeout(timer);
    }
}
