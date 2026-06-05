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
```

로컬에서 PowerShell을 사용할 경우 예시는 아래와 같습니다.

```powershell
$env:NAVER_CLIENT_ID="네이버_Client_ID"
$env:NAVER_CLIENT_SECRET="네이버_Client_Secret"
npm start
```

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
```

7. 배포가 끝나면 Render에서 제공하는 주소를 확인합니다.

예시:

```text
https://place-doctor-ai.onrender.com
```

## 아임웹 HTML 위젯 연결

1. `imweb-place-doctor-ai.html` 파일 전체를 복사합니다.
2. 아임웹 관리자에서 HTML 위젯을 추가합니다.
3. 복사한 코드를 붙여넣습니다.
4. 코드 최상단의 `API_URL`을 Render 서버 주소로 바꿉니다.

```html
<script>
  const API_URL = "https://place-doctor-ai.onrender.com";
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
  "blogText": "분석할 블로그 본문"
}
```

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
  "prompt": "AI 블로그 작성 프롬프트"
}
```

## 분석 로직 요약

- 네이버 지역 검색 결과에서 업체명이 포함된 항목을 찾아 플레이스 순위를 계산합니다.
- 네이버 블로그 검색 결과에서 업체명 또는 키워드가 포함된 글을 찾아 블로그 순위를 계산합니다.
- 블로그 본문은 키워드 배치, 첫 350자, 본문 길이, 후기형 단어, 구조 단어, 방문 유도 단어를 기준으로 점수화합니다.
- 1등 가능성 점수는 플레이스 순위, 블로그 순위, 블로그 글 점수, 지역 검색 노출 여부를 합산한 추정 점수입니다.
