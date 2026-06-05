const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const NAVER_LOCAL_URL = "https://openapi.naver.com/v1/search/local.json";
const NAVER_BLOG_URL = "https://openapi.naver.com/v1/search/blog.json";

function stripHtml(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .trim();
}

function normalizeText(value = "") {
  return stripHtml(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\uac00-\ud7a3a-z0-9]/g, "");
}

function containsNeedle(haystack, needle) {
  const normalizedHaystack = normalizeText(haystack);
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedHaystack || !normalizedNeedle) return false;
  return (
    normalizedHaystack.includes(normalizedNeedle) ||
    normalizedNeedle.includes(normalizedHaystack)
  );
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchNaverJson(url, params) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
    const error = new Error(
      "NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET 환경변수가 필요합니다."
    );
    error.status = 500;
    throw error;
  }

  const requestUrl = new URL(url);
  Object.entries(params).forEach(([key, value]) => {
    requestUrl.searchParams.set(key, value);
  });

  const response = await fetch(requestUrl, {
    headers: {
      "X-Naver-Client-Id": NAVER_CLIENT_ID,
      "X-Naver-Client-Secret": NAVER_CLIENT_SECRET
    }
  });

  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    data = { message: body };
  }

  if (!response.ok) {
    const error = new Error(data.errorMessage || data.message || "네이버 API 호출 실패");
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function mapLocalResults(items = []) {
  return items.map((item, index) => ({
    rank: index + 1,
    title: stripHtml(item.title),
    category: stripHtml(item.category),
    address: stripHtml(item.address),
    roadAddress: stripHtml(item.roadAddress),
    telephone: stripHtml(item.telephone),
    link: item.link || "",
    mapx: item.mapx || "",
    mapy: item.mapy || ""
  }));
}

function mapBlogResults(items = []) {
  return items.map((item, index) => ({
    rank: index + 1,
    title: stripHtml(item.title),
    description: stripHtml(item.description),
    bloggerName: stripHtml(item.bloggername),
    link: item.link || "",
    postdate: item.postdate || ""
  }));
}

function findPlaceRank(localResults, businessName) {
  const match = localResults.find((item) => containsNeedle(item.title, businessName));
  return match ? match.rank : null;
}

function findBlogRank(blogResults, businessName, keyword) {
  const match = blogResults.find((item) => {
    const content = `${item.title} ${item.description} ${item.bloggerName}`;
    return containsNeedle(content, businessName) || containsNeedle(content, keyword);
  });
  return match ? match.rank : null;
}

function extractTitleFromBlogText(blogText = "") {
  const firstLine = String(blogText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (firstLine && firstLine.length <= 120) return firstLine;
  return String(blogText).trim().slice(0, 80);
}

function countIncludedWords(text, words) {
  const normalized = normalizeText(text);
  return words.filter((word) => normalized.includes(normalizeText(word))).length;
}

function calculateBlogScore({ blogText, keyword, category }) {
  const text = String(blogText || "");
  const title = extractTitleFromBlogText(text);
  const first350 = text.slice(0, 350);
  const articleWords = [
    "후기",
    "추천",
    "가격",
    "시설",
    "위치",
    "리뷰",
    "초보",
    "다이어트",
    "운동",
    "PT",
    "피티",
    category
  ].filter(Boolean);
  const structureWords = ["장점", "이유", "비교", "체크", "방문", "상담"];
  const visitWords = ["네이버", "스마트플레이스", "지도"];

  let score = 0;
  const badges = [];
  const checks = {
    titleKeyword: containsNeedle(title, keyword),
    bodyKeyword: containsNeedle(text, keyword),
    categoryKeyword: category ? containsNeedle(text, category) : false,
    first350Keyword: containsNeedle(first350, keyword),
    enoughLength: text.length >= 3000,
    articleWordCount: countIncludedWords(text, articleWords),
    structureWordCount: countIncludedWords(text, structureWords),
    visitWordCount: countIncludedWords(text, visitWords)
  };

  if (checks.titleKeyword) {
    score += 15;
    badges.push("제목 키워드 적합");
  }
  if (checks.bodyKeyword) {
    score += 15;
    badges.push("본문 키워드 포함");
  }
  if (checks.categoryKeyword) {
    score += 5;
    badges.push("업종 키워드 포함");
  }
  if (checks.first350Keyword) {
    score += 15;
    badges.push("초반 350자 키워드 배치");
  }

  if (checks.enoughLength) {
    score += 15;
    badges.push("본문 3000자 이상");
  } else {
    score += Math.min(10, Math.floor((text.length / 3000) * 10));
  }

  score += Math.min(15, checks.articleWordCount * 2);
  if (checks.articleWordCount >= 5) badges.push("후기/추천형 검색어 풍부");

  score += Math.min(10, checks.structureWordCount * 2);
  if (checks.structureWordCount >= 3) badges.push("비교/체크형 구조 단어 포함");

  score += Math.min(10, checks.visitWordCount * 4);
  if (checks.visitWordCount >= 2) badges.push("네이버 방문 유도 문맥");

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    checks,
    title
  };
}

function rankScore(rank, maxScore) {
  if (!rank) return 0;
  if (rank === 1) return maxScore;
  if (rank <= 3) return Math.round(maxScore * 0.84);
  if (rank <= 5) return Math.round(maxScore * 0.68);
  if (rank <= 10) return Math.round(maxScore * 0.48);
  return Math.round(maxScore * 0.25);
}

function calculateTotalScore({ placeRank, blogRank, blogScore }) {
  const placeComponent = rankScore(placeRank, 30);
  const blogRankComponent = rankScore(blogRank, 25);
  const blogQualityComponent = Math.round(blogScore * 0.35);
  const exposureComponent = placeRank ? 10 : 0;

  return Math.min(
    100,
    placeComponent + blogRankComponent + blogQualityComponent + exposureComponent
  );
}

function createActions({ placeRank, blogRank, blogScore, businessName, keyword, category }) {
  const actions = [];

  if (!placeRank) {
    actions.push(`${keyword} 지역 검색 결과에 ${businessName} 노출을 먼저 확보하세요.`);
    actions.push("스마트플레이스 업체명, 카테고리, 주소, 대표 키워드 일치도를 점검하세요.");
  } else if (placeRank > 5) {
    actions.push(`현재 플레이스 ${placeRank}위입니다. 상위 5개 업체의 제목, 카테고리, 리뷰 문맥을 비교하세요.`);
  } else {
    actions.push(`플레이스 ${placeRank}위 노출을 유지하면서 블로그 콘텐츠로 클릭 근거를 강화하세요.`);
  }

  if (!blogRank || blogRank > 5) {
    actions.push(`${keyword} 키워드를 제목, 첫 문단, 소제목, 마무리 CTA에 자연스럽게 재배치하세요.`);
  } else {
    actions.push(`블로그 ${blogRank}위권 노출 흐름을 유지하고, 최신 후기형 글을 1건 추가 발행하세요.`);
  }

  if (blogScore < 70) {
    actions.push(`${category || "업종"} 관련 후기, 가격, 시설, 위치, 상담, 방문 문맥을 보강하세요.`);
  }

  actions.push("네이버 지도 또는 스마트플레이스 방문을 유도하는 문장을 글 하단에 넣으세요.");

  return actions.slice(0, 5);
}

function createPrompt({ businessName, keyword, category, blogScore, placeRank, blogRank }) {
  return [
    `너는 네이버 플레이스와 블로그 검색 최적화에 강한 ${category || "로컬 비즈니스"} 콘텐츠 전략가다.`,
    "",
    `업체명: ${businessName}`,
    `핵심 키워드: ${keyword}`,
    `업종: ${category || "미입력"}`,
    `현재 플레이스 순위: ${placeRank ? `${placeRank}위` : "미노출"}`,
    `현재 블로그 순위: ${blogRank ? `${blogRank}위` : "미노출"}`,
    `현재 블로그 글 품질 점수: ${blogScore}점`,
    "",
    "아래 조건을 지켜 네이버 블로그 글 초안을 작성해줘.",
    "1. 제목에는 핵심 키워드와 업체명을 자연스럽게 포함한다.",
    "2. 첫 350자 안에 핵심 키워드, 지역명, 업종, 방문 이유를 넣는다.",
    "3. 본문은 후기, 추천, 가격, 시설, 위치, 리뷰, 초보, 다이어트, 운동, PT, 피티 문맥을 자연스럽게 포함한다.",
    "4. 장점, 이유, 비교, 체크, 방문, 상담 흐름으로 소제목을 구성한다.",
    "5. 과장 광고처럼 보이지 않게 실제 방문 후기 톤으로 작성한다.",
    "6. 마지막 문단에는 네이버 지도 또는 스마트플레이스에서 업체를 확인하도록 유도한다.",
    "7. 글 전체는 3000자 이상으로 작성하고, 검색어 반복은 자연스럽게 유지한다.",
    "",
    "출력 형식:",
    "- 블로그 제목 5개",
    "- 본문 소제목 구조",
    "- 3000자 이상 본문 초안",
    "- 네이버 지도 방문 유도 문장 3개"
  ].join("\n");
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "플레이스박사 AI",
    message: "POST /api/analyze 엔드포인트를 사용하세요."
  });
});

app.post("/api/analyze", async (req, res, next) => {
  try {
    const businessName = String(req.body.businessName || "").trim();
    const keyword = String(req.body.keyword || "").trim();
    const category = String(req.body.category || "").trim();
    const blogText = String(req.body.blogText || "").trim();

    if (!businessName || !keyword) {
      return res.status(400).json({
        message: "businessName과 keyword는 필수 입력값입니다."
      });
    }

    const localQuery = [keyword, category].filter(Boolean).join(" ");
    const blogQuery = [businessName, keyword].filter(Boolean).join(" ");

    const [localData, blogData] = await Promise.all([
      fetchNaverJson(NAVER_LOCAL_URL, {
        query: localQuery,
        display: toPositiveInteger(req.query.localDisplay, 10),
        start: 1,
        sort: "random"
      }),
      fetchNaverJson(NAVER_BLOG_URL, {
        query: blogQuery,
        display: toPositiveInteger(req.query.blogDisplay, 10),
        start: 1,
        sort: "sim"
      })
    ]);

    const localResults = mapLocalResults(localData.items);
    const blogResults = mapBlogResults(blogData.items);
    const placeRank = findPlaceRank(localResults, businessName);
    const blogRank = findBlogRank(blogResults, businessName, keyword);
    const blogAnalysis = calculateBlogScore({ blogText, keyword, category });
    const blogScore = blogAnalysis.score;
    const totalScore = calculateTotalScore({ placeRank, blogRank, blogScore });
    const actions = createActions({
      placeRank,
      blogRank,
      blogScore,
      businessName,
      keyword,
      category
    });
    const badges = [
      ...(blogAnalysis.score >= 80 ? ["블로그 품질 우수"] : []),
      ...(placeRank ? ["플레이스 노출 확인"] : ["플레이스 미노출"]),
      ...(blogRank ? ["블로그 검색 노출 확인"] : ["블로그 미노출"]),
      ...(blogAnalysis.checks.first350Keyword ? ["초반 키워드 배치"] : []),
      ...(blogAnalysis.checks.enoughLength ? ["충분한 본문 길이"] : [])
    ];

    res.json({
      totalScore,
      placeRank,
      blogRank,
      blogScore,
      badges,
      localResults,
      blogResults,
      actions,
      prompt: createPrompt({
        businessName,
        keyword,
        category,
        blogScore,
        placeRank,
        blogRank
      })
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({
    message: error.message || "서버 오류가 발생했습니다.",
    details: error.details || undefined
  });
});

app.listen(PORT, () => {
  console.log(`플레이스박사 AI 서버 실행 중: http://localhost:${PORT}`);
});
