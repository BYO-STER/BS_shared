// 공유 서버(Supabase) 접속 값 — PC main.js 의 SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY 와 같은
// 프로젝트를 가리켜야 한다(같은 데이터를 보는 것이 목적).
//
// publishable(anon) 키는 클라이언트에 심는 것을 전제로 만들어진 공개 키다 — 이 키만으로는
// 아무 데이터도 볼 수 없고, 실제 접근 권한은 로그인한 계정과 서버의 RLS 정책이 정한다.
// 비밀 키(service_role)는 절대 이 파일에 넣지 말 것 — 그 키는 RLS 를 통째로 건너뛴다.
export const SUPABASE_URL = "https://oleuegmarabvymlkbsws.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Tvu28wmE8HF5oIavHDmv1Q_GDSb8-jp";
