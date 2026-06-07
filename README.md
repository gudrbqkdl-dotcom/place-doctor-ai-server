# 플레이스박사 AI MVP

아임웹 HTML 위젯에서 사용하는 프론트엔드와 Render에 배포하는 Node.js API 서버로 구성된 MVP입니다.

## 파일 구성

```text
place-doctor-ai-mvp/
  imweb-place-doctor-ai.html
  server.js
  package.json
  README.md
```

## 핵심 원칙

- 네이버 API 키는 프론트엔드 HTML에 절대 넣지 않습니다.
- 아임웹 HTML 코드는 화면과 API 호출만 담당합니다.
- 네이버 검색 데이터 수집과 분석은 Node 서버에서만 처리합니다.
- 불법 크롤링이 아니라 네이버 공식 검색 API 기준으로 동작합니다.
- 1등 가능성 점수는 네이버 공식 1등 점수가 아니라 공식 공개 기준 기반 추정 점수입니다.
- 실제 네이버 VIEW, 인기글, 스마트블록 화면 순서는 공식 API와 다를 수 있으므로 화면에서 직접 확인 링크를 함께 제공합니다.
- 리뷰 수는 네이버 공식 검색 API에서 직접 제공하지 않으므로, 화면의 리뷰 추적 기능에 직접 입력해 주간 변화를 관리합니다.

## 현재 화면 기능

- 순위분석: 플레이스 순위, 블로그 API 순위, 상위 블로그 점수를 보고 위험 신호와 다음 액션을 보여줍니다.
- 순위추적: 분석할 때마다 이 브라우저에 순위 기록을 저장합니다.
- 실제 블로그 확인: 네이버 VIEW와 블로그탭을 바로 열 수 있는 버튼을 제공합니다.
- 실제 VIEW 순위 메모: 직접 확인한 실제 화면 순위를 저장할 수 있습니다.
- 리뷰추적: 현재 리뷰 수, 목표 리뷰 수, 리뷰 메모를 저장합니다.
- 경쟁 플레이스: 네이버 지역 검색 API 기준 상위 업체를 보여줍니다.
- 공식 API 상위 블로그: 네이버 블로그 검색 API 기준 상위 블로그를 보여주고, 각 글을 바로 열 수 있습니다.
- AI 블로그 원고: 프롬프트는 숨기고 네이버 블로그에 붙여넣을 완성 원고만 보여줍니다.
- 빠른 분석 구조: `/api/analyze`는 순위와 점수를 먼저 빠르게 반환하고, 긴 AI 원고는 `/api/draft`에서 별도로 생성합니다.

## 로컬 실행

```bash
npm install
npm start
```

서버는 기본적으로 `http://localhost:3000`에서 실행됩니다.

## 네이버 개발자센터 API 키 받는 법

1. [네이버 개발자센터](https://developers.naver.com/)에 로그인합니다.
2. 상단 메뉴에서 `Application` 또는 `내 애플리케이션`으로 이동합니다.
3. `애플리케이션 등록`을 선택합니다.
4. 사용 API에서 `검색`을 선택합니다.
5. 서비스 환경은 서버 배포 도메인에 맞게 설정합니다.
6. 등록 후 발급되는 `Client ID`와 `Client Secret`을 복사합니다.

이 MVP는 아래 공식 검색 API를 사용합니다.

- `https://openapi.naver.com/v1/search/local.json`
- `https://openapi.naver.com/v1/search/blog.json`

## 환경변수 설정

로컬 또는 Render 서버에 아래 값을 환경변수로 넣습니다.

```bash
NAVER_CLIENT_ID=네이버_Client_ID
NAVER_CLIENT_SECRET=네이버_Client_Secret
OPENAI_API_KEY=OpenAI_API_Key_선택사항
OPENAI_MODEL=gpt-4o-mini
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_API_STYLE=responses
OPENAI_RESPONSES_URL=
OPENAI_CHAT_COMPLETIONS_URL=
AI_DRAFT_REQUIRED=true
AI_FAIL_OPEN=true
AI_MAX_TOKENS=7000
AI_CONTEXT_RESULT_LIMIT=3
AI_TARGET_MIN_CHARS=4300
AI_TIMEOUT_MS=30000
NAVER_REQUEST_DELAY_MS=70
```

로컬에서 PowerShell을 사용할 경우 예시는 아래와 같습니다.

```powershell
$env:NAVER_CLIENT_ID="네이버_Client_ID"
$env:NAVER_CLIENT_SECRET="네이버_Client_Secret"
$env:OPENAI_API_KEY="OpenAI_API_Key_선택사항"
$env:OPENAI_API_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_API_STYLE="responses"
npm start
```

`OPENAI_API_KEY`는 직접 OpenAI를 연결할 때 사용하는 값입니다. Cloudflare Worker 프록시를 쓸 경우에는 `OPENAI_API_KEY` 대신 `OPENAI_CHAT_COMPLETIONS_URL`을 넣으면 됩니다.

속도를 줄이면서도 글 품질을 유지하려면 Render 환경변수에 `OPENAI_MODEL=gpt-4o-mini`, `AI_MAX_TOKENS=7000`, `AI_CONTEXT_RESULT_LIMIT=3`, `AI_TARGET_MIN_CHARS=4300`, `AI_TIMEOUT_MS=30000`을 넣어두면 됩니다.

중요: OpenAI API 키도 네이버 API 키처럼 프론트엔드 HTML에 넣으면 안 됩니다. Render 서버의 Environment Variables에만 넣으세요.

현재 버전은 `AI_DRAFT_REQUIRED=true`가 기본값입니다. 즉 AI 원고 작성 서버가 연결되지 않으면 기본 원고로 몰래 넘어가지 않고 오류를 보여줍니다. 반드시 AI로 블로그 글을 작성하게 하기 위한 설정입니다. 테스트용으로만 기본 원고를 허용하려면 Render 환경변수에 `AI_DRAFT_REQUIRED=false`를 넣으면 됩니다.

## Render에 서버 배포하는 법

1. 이 폴더의 파일을 GitHub 저장소에 업로드합니다.
2. [Render](https://render.com/)에 로그인합니다.
3. `New` -> `Web Service`를 선택합니다.
4. GitHub 저장소를 연결합니다.
5. 설정값을 아래처럼 입력합니다.

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
```

6. `Environment` 또는 `Environment Variables` 메뉴에 아래 값을 추가합니다.

```text
NAVER_CLIENT_ID
NAVER_CLIENT_SECRET
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_API_BASE_URL
OPENAI_API_STYLE
OPENAI_RESPONSES_URL
OPENAI_CHAT_COMPLETIONS_URL
```

`OPENAI_API_KEY`는 직접 OpenAI를 연결할 때만 넣으면 됩니다. Worker 프록시를 쓰는 경우에는 `OPENAI_CHAT_COMPLETIONS_URL`을 넣습니다. 빠른 생성을 원하면 `OPENAI_MODEL=gpt-4o-mini`를 권장합니다.

Cloudflare Worker 같은 OpenAI 프록시 서버를 쓰는 경우에는 Render 환경변수에 아래처럼 넣습니다.

```text
OPENAI_CHAT_COMPLETIONS_URL=https://winter-resonance-93f1.qkdlgudrb.workers.dev
OPENAI_API_STYLE=chat
AI_DRAFT_REQUIRED=true
AI_FAIL_OPEN=true
OPENAI_MODEL=gpt-4o-mini
AI_MAX_TOKENS=7000
AI_CONTEXT_RESULT_LIMIT=3
AI_TARGET_MIN_CHARS=4300
AI_TIMEOUT_MS=30000
```

중요: `https://winter-resonance-93f1.qkdlgudrb.workers.dev` 주소는 아임웹 HTML의 `API_URL`에 넣는 주소가 아닙니다. 이 주소는 Render 서버가 AI 원고를 만들 때 내부에서 사용하는 주소입니다. 아임웹 HTML의 `API_URL`에는 반드시 Render 서버 주소를 넣으세요.

7. 배포가 끝나면 Render에서 제공하는 주소를 확인합니다.

예시:

```text
https://place-doctor-ai.onrender.com
```

## 아임웹 HTML 위젯 연결

1. `imweb-place-doctor-ai.html` 파일 전체를 복사합니다.
2. 아임웹 관리자에서 HTML 위젯을 추가합니다.
3. 복사한 코드를 붙여넣습니다.
4. 코드 최상단의 `API_URL`을 실제 분석 API 서버 주소로 바꿉니다.

```html
<script>
  const API_URL = "https://place-doctor-ai-server.onrender.com";
</script>
```

5. 저장 후 페이지에서 분석을 실행합니다.

## API 사용법

### POST `/api/analyze`

요청:

```json
{
  "businessName": "트리트라움 피트니스",
  "keyword": "동해헬스장",
  "category": "헬스장",
  "blogText": "선택 메모"
}
```

주의: 현재 화면은 분석 속도를 빠르게 하기 위해 `/api/analyze`에서 AI 원고를 기다리지 않습니다. 점수와 순위가 먼저 뜬 뒤, 화면이 자동으로 `/api/draft`를 호출해 AI 원고를 채웁니다.

업체명 칸에 아래처럼 같이 입력해도 서버가 자동으로 나눕니다.

```json
{
  "businessName": "트리트라움 (강릉헬스장)",
  "keyword": "동핼헬스장",
  "category": "헬스장"
}
```

위 예시는 서버에서 자동으로 `businessName=트리트라움`, `keyword=강릉헬스장`으로 정리됩니다.

응답:

```json
{
  "totalScore": 78,
  "placeRank": 3,
  "blogRank": 2,
  "blogScore": 82,
  "badges": ["플레이스 노출 확인", "블로그 검색 노출 확인"],
  "localResults": [],
  "blogResults": [],
  "actions": [],
  "rankAnalysis": {
    "level": "상승 준비 구간",
    "summary": "현재 상태 요약",
    "risks": [],
    "nextActions": []
  },
  "visibleBlogCheck": {
    "viewUrl": "https://search.naver.com/...",
    "blogUrl": "https://search.naver.com/..."
  },
  "recommendedKeywords": {
    "primary": [],
    "longTail": [],
    "place": [],
    "content": []
  },
  "draft": "제목:\n...\n\n본문:\n...\n\n태그:\n#키워드",
  "draftSource": "openai",
  "normalizedInput": {},
  "prompt": "AI 블로그 작성 프롬프트"
}
```

### POST `/api/draft`

분석 결과를 바탕으로 AI 블로그 원고만 따로 생성합니다. 화면에서는 자동으로 호출되며, 사용자가 직접 누를 수 있는 `AI 원고 다시 생성` 버튼도 있습니다.

요청:

```json
{
  "businessName": "트리트라움 피트니스",
  "keyword": "동해헬스장",
  "category": "헬스장",
  "blogResults": [],
  "localResults": [],
  "blogScore": 78,
  "blogRank": 2,
  "placeRankLabel": "5위권밖",
  "recommendedKeywords": {},
  "prompt": "AI 블로그 작성 프롬프트"
}
```

응답:

```json
{
  "draft": "제목:\n...\n\n본문:\n...\n\n해시태그:\n...",
  "draftSource": "openai",
  "openAIStatus": "connected"
}
```

## 분석 로직 요약

- 네이버 지역 검색 결과에서 업체명이 포함된 항목을 찾아 플레이스 순위를 계산합니다.
- 네이버 공식 지역검색 API는 최대 5개 결과만 제공하므로, 6위 이하의 정확한 순위는 공식 API만으로 확인할 수 없습니다.
- 키워드 검색에 업체가 없을 경우 업체명, 업체명+키워드, 업체명+업종 검색을 추가로 확인해 업체 등록 여부를 보조 판단합니다.
- 강원도 운동 업종 키워드는 강릉, 동해, 원주, 춘천, 속초, 삼척, 태백, 홍천, 횡성, 영월, 평창, 정선, 철원, 화천, 양구, 인제, 고성, 양양과 헬스장, 헬스, 피트니스, PT, 피티, 운동 키워드로 자동 확장합니다.
- 네이버 API 속도 제한을 피하기 위해 검색 요청은 순차 처리하고, 같은 검색 결과는 10분간 캐시합니다.
- 블로그 현재 순위는 네이버 공식 블로그 검색 API 기준입니다. 실제 네이버 화면의 VIEW, 인기글, 스마트블록 순서와 1:1로 같지 않을 수 있습니다.
- 네이버 실제 화면 순서는 개인화, 기기, 지역, 스마트블록, VIEW 섹션 구성에 따라 달라질 수 있고, 공식 API에서는 이 화면 순서를 그대로 제공하지 않습니다.
- 그래서 화면에는 공식 API 기준 상위 블로그와 네이버 직접 확인 링크를 함께 표시합니다.
- 실제 네이버 화면과 완전히 같은 순위를 자동으로 넣으려면 공식 검색 API가 아니라 별도 SERP 수집 API 또는 브라우저 자동 확인 기능이 필요합니다. 이 방식은 네이버 공식 API가 아니므로 운영 전 약관과 안정성을 별도로 확인해야 합니다.
- 리뷰 수 자동 추적도 네이버 검색 API 응답에 리뷰 수 필드가 없기 때문에 직접 제공되지 않습니다. 지역 검색 API의 `sort=comment`는 리뷰 개수순 정렬에 활용할 수 있지만, 실제 리뷰 수를 숫자로 반환하지는 않습니다.
- 블로그 API 기준 순위는 대표키워드 검색 결과 안에서 업체명이 실제로 포함된 글만 기준으로 계산합니다.
- `업체명+키워드` 검색이나 업체명 단독 검색에서만 발견된 글은 현재 순위로 착각하지 않도록 별도 확인값으로만 사용합니다.
- 블로그 글 점수는 사용자가 직접 붙여넣은 본문이 아니라, 네이버 블로그 검색 상위 결과의 제목과 설명 문맥을 기준으로 계산합니다.
- 네이버 상위 블로그와 지역 검색 결과를 참고해 메인 키워드, 보조 키워드, 업체명 키워드, 본문 문맥 키워드를 자동 추천합니다.
- 입력한 업체명, 키워드, 업종, 자동 추천 키워드, 상위 블로그 목록을 참고해 네이버 블로그 발행용 완성 원고를 자동 생성합니다.
- 완성 원고는 전략 보고서가 아니라 `제목`, `본문`, `태그` 형태로 바로 복사해 올릴 수 있게 생성됩니다.
- `AI_DRAFT_REQUIRED=true` 상태에서는 OpenAI 프록시 주소 또는 OpenAI API 키가 있어야 원고가 생성됩니다. AI 연결이 실패하면 기본 원고로 대체하지 않고 오류를 보여줍니다.
- 블로그 원고는 일반 SEO가 아니라 네이버 플레이스 클릭, 체류시간, 전화문의, 방문예약, 회원등록 전환을 목표로 작성합니다.
- 대표키워드는 본문에 8~12회, 업체명은 5회 이상 자연스럽게 삽입하고, 정보성 70%, 홍보성 30% 비율로 작성합니다.
- 트리트라움 입력 시 AI운동솔루션, 프리미엄 머신 gym80, 요가·필라테스 통합 웰니스센터 차별점이 원고 작성 조건에 자동 반영됩니다.
- 1등 가능성 점수는 플레이스 순위, 블로그 순위, 블로그 글 점수, 지역 검색 노출 여부를 합산한 추정 점수입니다.
