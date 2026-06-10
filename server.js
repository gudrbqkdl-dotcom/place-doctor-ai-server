const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const NAVER_CLIENT_ID = process.env.NAVER_CLIENT_ID;
const NAVER_CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_BASE_URL = (process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_API_STYLE = (process.env.OPENAI_API_STYLE || (OPENAI_API_BASE_URL.includes("workers.dev") ? "chat" : "responses")).toLowerCase();
const OPENAI_RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || `${OPENAI_API_BASE_URL}/responses`;
const OPENAI_CHAT_COMPLETIONS_URL = process.env.OPENAI_CHAT_COMPLETIONS_URL || `${OPENAI_API_BASE_URL}/chat/completions`;
const AI_DRAFT_REQUIRED = String(process.env.AI_DRAFT_REQUIRED || "true").toLowerCase() !== "false";
const AI_FAIL_OPEN = String(process.env.AI_FAIL_OPEN || "true").toLowerCase() !== "false";
const AI_MAX_TOKENS = Math.max(6200, Math.min(9000, Number.parseInt(process.env.AI_MAX_TOKENS || "7000", 10) || 7000));
const AI_CONTEXT_RESULT_LIMIT = Math.max(3, Math.min(5, Number.parseInt(process.env.AI_CONTEXT_RESULT_LIMIT || "3", 10) || 3));
const AI_TARGET_MIN_CHARS = Math.max(4000, Math.min(6500, Number.parseInt(process.env.AI_TARGET_MIN_CHARS || "4300", 10) || 4300));
const AI_TIMEOUT_MS = Math.max(15000, Math.min(55000, Number.parseInt(process.env.AI_TIMEOUT_MS || "22000", 10) || 22000));
const OPENAI_PROXY_CONFIGURED = Boolean(
  process.env.OPENAI_RESPONSES_URL ||
    process.env.OPENAI_CHAT_COMPLETIONS_URL ||
    OPENAI_API_BASE_URL !== "https://api.openai.com/v1"
);
const OPENAI_ENABLED = Boolean(OPENAI_API_KEY || OPENAI_PROXY_CONFIGURED);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
});
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const NAVER_LOCAL_URL = "https://openapi.naver.com/v1/search/local.json";
const NAVER_BLOG_URL = "https://openapi.naver.com/v1/search/blog.json";
const NAVER_CACHE_TTL_MS = 10 * 60 * 1000;
const NAVER_REQUEST_DELAY_MS = Math.max(40, Number.parseInt(process.env.NAVER_REQUEST_DELAY_MS || "70", 10) || 70);
const naverCache = new Map();

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInteger(value, fallback, min, max) {
  return Math.max(min, Math.min(max, toPositiveInteger(value, fallback)));
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeText(getKey(item));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactUnique(values) {
  return uniqueBy(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean),
    (value) => value
  );
}

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeTermsFromText(value = "", terms = []) {
  let cleaned = String(value || "").trim();
  compactUnique(terms)
    .filter((term) => normalizeText(term).length >= 2)
    .sort((a, b) => String(b).length - String(a).length)
    .forEach((term) => {
      cleaned = cleaned.replace(new RegExp(escapeRegex(term), "gi"), " ");
    });

  return cleaned.replace(/\s+/g, " ").trim();
}

function removeKeywordFromBusinessName(businessName = "", keyword = "", category = "") {
  const raw = String(businessName || "").trim();
  const keywordNoSpace = String(keyword || "").replace(/\s+/g, "");
  const categoryNoSpace = String(category || "").replace(/\s+/g, "");
  const cleaned = removeTermsFromText(raw, [
    keyword,
    keywordNoSpace,
    category,
    categoryNoSpace
  ]);

  return cleaned || raw;
}

function createNaverSearchUrl(query, where = "view") {
  const params = new URLSearchParams({
    where,
    query: String(query || "").trim()
  });
  return `https://search.naver.com/search.naver?${params.toString()}`;
}

function fixCommonKeywordTypos(value = "") {
  return String(value)
    .replace(/동핼/g, "동해")
    .replace(/헬스쟝/g, "헬스장")
    .trim();
}

function splitParenthesizedInput(value = "") {
  const text = String(value || "").trim();
  const match = text.match(/^(.+?)\s*[\(（]\s*([^)）]+)\s*[\)）]\s*$/);
  if (!match) return { main: text, detail: "" };
  return {
    main: match[1].trim(),
    detail: match[2].trim()
  };
}

function normalizeAnalyzeInput({ businessName, keyword, category }) {
  const rawBusinessName = String(businessName || "").trim();
  const rawKeyword = String(keyword || "").trim();
  const rawCategory = String(category || "").trim();
  const businessParts = splitParenthesizedInput(rawBusinessName);
  const keywordParts = splitParenthesizedInput(rawKeyword);

  let cleanBusinessName = businessParts.main || rawBusinessName;
  let cleanKeyword = rawKeyword;

  if (businessParts.detail) {
    cleanKeyword = businessParts.detail;
  } else if (keywordParts.detail) {
    cleanKeyword = keywordParts.detail;
    if (!cleanBusinessName && keywordParts.main) {
      cleanBusinessName = keywordParts.main;
    }
  }

  const fixedKeyword = fixCommonKeywordTypos(cleanKeyword);
  const cleanCategory = rawCategory || "헬스장";
  const finalBusinessName = removeKeywordFromBusinessName(
    cleanBusinessName,
    fixedKeyword,
    cleanCategory
  );

  return {
    businessName: finalBusinessName.trim(),
    keyword: fixedKeyword,
    category: cleanCategory,
    rawBusinessName,
    rawKeyword,
    rawCategory,
    separated: Boolean(businessParts.detail || keywordParts.detail)
  };
}

const GANGWON_REGIONS = [
  { base: "강릉", aliases: ["강릉", "강릉시"] },
  { base: "동해", aliases: ["동해", "동해시"] },
  { base: "원주", aliases: ["원주", "원주시"] },
  { base: "춘천", aliases: ["춘천", "춘천시"] },
  { base: "속초", aliases: ["속초", "속초시"] },
  { base: "삼척", aliases: ["삼척", "삼척시"] },
  { base: "태백", aliases: ["태백", "태백시"] },
  { base: "홍천", aliases: ["홍천", "홍천군"] },
  { base: "횡성", aliases: ["횡성", "횡성군"] },
  { base: "영월", aliases: ["영월", "영월군"] },
  { base: "평창", aliases: ["평창", "평창군"] },
  { base: "정선", aliases: ["정선", "정선군"] },
  { base: "철원", aliases: ["철원", "철원군"] },
  { base: "화천", aliases: ["화천", "화천군"] },
  { base: "양구", aliases: ["양구", "양구군"] },
  { base: "인제", aliases: ["인제", "인제군"] },
  { base: "고성", aliases: ["고성", "고성군"] },
  { base: "양양", aliases: ["양양", "양양군"] }
];

const FITNESS_TERMS = [
  "헬스장",
  "헬스",
  "피트니스",
  "PT",
  "피티",
  "운동",
  "운동센터",
  "퍼스널트레이닝"
];

const COMMON_CATEGORY_TERMS = [
  ...FITNESS_TERMS,
  "맛집",
  "카페",
  "커피",
  "식당",
  "음식점",
  "술집",
  "병원",
  "의원",
  "치과",
  "한의원",
  "약국",
  "미용실",
  "네일",
  "피부관리",
  "마사지",
  "필라테스",
  "요가",
  "학원",
  "호텔",
  "펜션",
  "숙소",
  "공방",
  "세차",
  "정비",
  "부동산",
  "사진관",
  "스튜디오"
];

function hasFitnessIntent(keyword, category) {
  const normalized = normalizeText(`${keyword} ${category}`);
  return FITNESS_TERMS.some((term) => normalized.includes(normalizeText(term)));
}

function getCategorySearchTerms(category) {
  const cleanCategory = String(category || "").trim();
  const categoryStem = cleanCategory.replace(/(장|점|집|센터|샵)$/g, "").trim();
  return compactUnique([
    cleanCategory,
    categoryStem,
    ...COMMON_CATEGORY_TERMS
  ]).sort((a, b) => b.length - a.length);
}

function extractLikelyLocations(keyword, category) {
  const cleanKeyword = String(keyword || "").trim();
  if (!cleanKeyword) return [];

  const categoryTerms = getCategorySearchTerms(category);
  const locations = [];
  const firstToken = cleanKeyword.split(/\s+/)[0];
  if (firstToken && firstToken !== cleanKeyword) {
    const tokenWithoutCategory = categoryTerms.reduce(
      (text, term) => text.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), ""),
      firstToken
    ).trim();
    if (tokenWithoutCategory && tokenWithoutCategory.length >= 2 && tokenWithoutCategory.length <= 12) {
      locations.push(tokenWithoutCategory);
    }
  }

  const withoutCategory = categoryTerms.reduce(
    (text, term) => text.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), ""),
    cleanKeyword
  ).replace(/\s+/g, "").trim();

  if (
    withoutCategory &&
    withoutCategory !== cleanKeyword.replace(/\s+/g, "") &&
    withoutCategory.length >= 2 &&
    withoutCategory.length <= 12
  ) {
    locations.push(withoutCategory);
  }

  return compactUnique(locations);
}

function isGangwonWideKeyword(keyword) {
  const normalized = normalizeText(keyword);
  return normalized.includes("강원도") || normalized.includes("강원전체") || normalized === "강원";
}

function findGangwonRegions(keyword) {
  if (isGangwonWideKeyword(keyword)) return GANGWON_REGIONS;

  const normalizedKeyword = normalizeText(keyword);
  return GANGWON_REGIONS.filter((region) =>
    region.aliases.some((alias) => normalizedKeyword.includes(normalizeText(alias)))
  );
}

function getPrimaryFitnessTerm(keyword, category) {
  const normalized = normalizeText(`${keyword} ${category}`);
  if (normalized.includes("헬스")) return "헬스장";
  if (normalized.includes("피트니스")) return "피트니스";
  if (normalized.includes("pt")) return "PT";
  if (normalized.includes("피티")) return "피티";
  if (normalized.includes("운동")) return "운동";
  return category || "운동";
}

function buildGangwonFitnessVariants({ keyword, category }) {
  if (!hasFitnessIntent(keyword, category)) return [];

  const regions = findGangwonRegions(keyword);
  if (!regions.length) return [];

  const wideKeyword = isGangwonWideKeyword(keyword);
  const primaryTerm = getPrimaryFitnessTerm(keyword, category);
  const terms = wideKeyword ? [primaryTerm] : compactUnique([primaryTerm, ...FITNESS_TERMS]);
  const variants = [];

  regions.forEach((region) => {
    const aliases = wideKeyword ? region.aliases : compactUnique([region.base, ...region.aliases]);
    aliases.forEach((alias) => {
      terms.forEach((term) => {
        variants.push(`${alias}${term}`);
        variants.push(`${alias} ${term}`);
      });
    });
  });

  return compactUnique(variants);
}

function buildKeywordVariants({ keyword, category }) {
  const cleanKeyword = String(keyword || "").trim();
  const cleanCategory = String(category || "").trim();
  const variants = [cleanKeyword];
  const locationCandidates = extractLikelyLocations(cleanKeyword, cleanCategory);

  const normalizedKeyword = normalizeText(cleanKeyword);
  const normalizedCategory = normalizeText(cleanCategory);
  const categoryStem = cleanCategory.replace(/장$/g, "").trim();

  if (
    (normalizedCategory.includes("헬스") || normalizedKeyword.includes("헬스")) &&
    normalizedKeyword.endsWith("헬스") &&
    !normalizedKeyword.endsWith("헬스장")
  ) {
    const region = cleanKeyword.replace(/헬스\s*$/i, "").trim();
    if (region) {
      variants.push(`${region}헬스장`);
      variants.push(`${region} 헬스장`);
      variants.push(`${region}피트니스`);
      variants.push(`${region} 피트니스`);
      variants.push(`${region}PT`);
      variants.push(`${region} PT`);
      variants.push(`${region}피티`);
      variants.push(`${region} 피티`);
    }
  }

  variants.push(...buildGangwonFitnessVariants({ keyword: cleanKeyword, category: cleanCategory }));

  locationCandidates.forEach((location) => {
    if (cleanCategory) {
      variants.push(`${location}${cleanCategory}`);
      variants.push(`${location} ${cleanCategory}`);
    }
    if (categoryStem && categoryStem !== cleanCategory) {
      variants.push(`${location}${categoryStem}`);
      variants.push(`${location} ${categoryStem}`);
    }
  });

  if (
    cleanCategory &&
    !containsNeedle(cleanKeyword, cleanCategory) &&
    !(categoryStem && containsNeedle(cleanKeyword, categoryStem))
  ) {
    variants.push(`${cleanKeyword} ${cleanCategory}`);
    variants.push(`${cleanKeyword}${cleanCategory}`);
  }

  return compactUnique(variants);
}

function buildLocalQueries({ businessName, keyword, category }) {
  const keywordVariants = buildKeywordVariants({ keyword, category });
  const keywordLimit = isGangwonWideKeyword(keyword) ? 10 : 7;
  const selectedKeywords = keywordVariants.slice(0, keywordLimit);
  const locations = extractLikelyLocations(keyword, category);
  const businessQueries = selectedKeywords.slice(0, 4).flatMap((query) => [
    `${businessName} ${query}`,
    `${query} ${businessName}`
  ]);
  const locationBusinessQueries = locations.flatMap((location) => [
    `${businessName} ${location}`,
    `${location} ${businessName}`,
    `${businessName} ${location} ${category}`,
    `${location} ${category} ${businessName}`
  ]);

  return compactUnique([
    ...selectedKeywords,
    keyword,
    ...businessQueries,
    ...locationBusinessQueries,
    `${businessName} ${category}`,
    `${category} ${businessName}`,
    businessName
  ]).slice(0, isGangwonWideKeyword(keyword) ? 18 : 14);
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

  const cacheKey = requestUrl.toString();
  const cached = naverCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < NAVER_CACHE_TTL_MS) {
    return cached.data;
  }

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await sleep(NAVER_REQUEST_DELAY_MS * (attempt + 2));
    }

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

    if (response.ok) {
      naverCache.set(cacheKey, { data, savedAt: Date.now() });
      return data;
    }

    lastError = new Error(data.errorMessage || data.message || "네이버 API 호출 실패");
    lastError.status = response.status;
    lastError.details = data;

    const rateLimited =
      response.status === 429 ||
      String(data.errorMessage || data.message || "").toLowerCase().includes("rate limit");
    if (!rateLimited) break;
  }

  throw lastError;
}

function mapLocalResults(items = [], options = {}) {
  return items.map((item, index) => ({
    rank: index + 1,
    rankLabel: String(index + 1),
    searchQuery: options.searchQuery || "",
    searchType: options.searchType || "keyword",
    matchNote: options.matchNote || "",
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

function mapBlogResults(items = [], options = {}) {
  return items.map((item, index) => ({
    rank: index + 1,
    rankLabel: String(index + 1),
    searchQuery: options.searchQuery || "",
    searchType: options.searchType || "keyword",
    title: stripHtml(item.title),
    description: stripHtml(item.description),
    bloggerName: stripHtml(item.bloggername),
    link: item.link || "",
    postdate: item.postdate || ""
  }));
}

/* 네이버 검색 페이지 HTML을 브라우저처럼 가져온다 (캐시 + 12초 타임아웃) */
async function fetchSearchPageHtml(url) {
  const cacheKey = `serp:${url.toString()}`;
  const cached = naverCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < NAVER_CACHE_TTL_MS) {
    return cached.data;
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9"
      },
      signal: controller ? controller.signal : undefined
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) {
    const error = new Error(`네이버 검색 페이지 응답 오류 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const html = await response.text();
  naverCache.set(cacheKey, { data: html, savedAt: Date.now() });
  return html;
}

/* 네이버 통합검색의 "인기글" 블록을 사용자가 보는 화면 순서 그대로 읽는다.
   채널(블로거/카페) 링크가 나오면 새 묶음이 시작되고, 묶음의 첫 글이 대표글(순위),
   그 아래 딸린 글은 묶음글로 표시한다. 블로그글과 카페글을 모두 포함한다. */
async function fetchNaverPopularPosts(keyword, limit = 30) {
  const url = new URL("https://search.naver.com/search.naver");
  url.searchParams.set("where", "nexearch");
  url.searchParams.set("sm", "top_hty");
  url.searchParams.set("query", String(keyword || "").trim());
  const html = await fetchSearchPageHtml(url);

  let headingIdx = html.indexOf("인기글<");
  if (headingIdx < 0) headingIdx = html.indexOf("인기글");
  if (headingIdx < 0) {
    throw new Error("통합검색 결과에 인기글 블록이 없습니다");
  }
  let sectionEnd = html.indexOf("</section>", headingIdx);
  if (sectionEnd < 0) sectionEnd = Math.min(html.length, headingIdx + 160000);
  const block = html.slice(headingIdx, sectionEnd);

  const anchorRegex =
    /<a\b[^>]*href="(https:\/\/(?:m\.)?(?:blog|cafe)\.naver\.com\/([^"\/?]+)(?:\/(\d+))?)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const results = [];
  let currentChannel = "";
  let groupHasMain = false;
  let mainCount = 0;
  let match;
  while ((match = anchorRegex.exec(block)) !== null) {
    const link = match[1]
      .replace("//m.blog.", "//blog.")
      .replace("//m.cafe.", "//cafe.");
    const postId = match[3];
    const innerText = stripHtml(match[4]);

    if (!postId) {
      /* 글번호가 없는 링크 = 채널(블로거/카페) 홈 → 새 묶음 시작 */
      if (innerText) currentChannel = innerText;
      groupHasMain = false;
      continue;
    }
    if (innerText.length < 4) continue; /* 썸네일 등 제목 없는 링크 제외 */
    if (/(?:blog|cafe)\.naver\.com/.test(innerText)) continue; /* 하단 추천영역의 주소 노출형 링크 제외 */
    if (seen.has(link)) continue;
    seen.add(link);

    if (!groupHasMain) {
      mainCount += 1;
      groupHasMain = true;
      results.push({
        rank: mainCount,
        rankLabel: String(mainCount),
        searchQuery: String(keyword || "").trim(),
        searchType: "serp",
        title: innerText,
        description: "",
        bloggerName: currentChannel,
        link,
        postdate: "",
        isSubPost: false
      });
    } else {
      results.push({
        rank: mainCount,
        rankLabel: `${mainCount}위 묶음글`,
        searchQuery: String(keyword || "").trim(),
        searchType: "serp",
        title: innerText,
        description: "",
        bloggerName: currentChannel,
        link,
        postdate: "",
        isSubPost: true
      });
    }
    if (mainCount >= limit) break;
  }

  if (mainCount < 1) {
    throw new Error("인기글 블록에서 글을 찾지 못했습니다");
  }
  return results;
}

/* 네이버 블로그탭 검색 화면을 노출 순서대로 읽는다 (인기글 블록이 없을 때 2차 수단) */
async function fetchNaverBlogTabResults(keyword, limit = 30) {
  const url = new URL("https://search.naver.com/search.naver");
  url.searchParams.set("ssc", "tab.blog.all");
  url.searchParams.set("sm", "tab_jum");
  url.searchParams.set("query", String(keyword || "").trim());
  const html = await fetchSearchPageHtml(url);

  const anchorRegex = /<a\b[^>]*href="(https:\/\/(?:m\.)?blog\.naver\.com\/[^"\/]+\/\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const results = [];
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const link = match[1].replace("//m.blog.", "//blog.");
    const title = stripHtml(match[2]);
    if (title.length < 8) continue; /* 썸네일·블로거명 링크 제외, 제목 링크만 수집 */
    if (seen.has(link)) continue;
    seen.add(link);
    results.push({
      rank: results.length + 1,
      rankLabel: String(results.length + 1),
      searchQuery: String(keyword || "").trim(),
      searchType: "serp",
      title,
      description: "",
      bloggerName: "",
      link,
      postdate: "",
      isSubPost: false
    });
    if (results.length >= limit) break;
  }
  return results;
}

function findPlaceRank(localResults, businessName) {
  const match = localResults.find((item) => containsNeedle(item.title, businessName));
  return match ? match.rank : null;
}

async function analyzeLocalResults({ businessName, keyword, category, localDisplay }) {
  const queries = buildLocalQueries({ businessName, keyword, category });
  const display = clampInteger(localDisplay, 5, 1, 5);

  const searches = [];
  const searchErrors = [];
  for (const query of queries) {
    const searchType = containsNeedle(query, businessName) ? "business" : "keyword";
    try {
      const data = await fetchNaverJson(NAVER_LOCAL_URL, {
        query,
        display,
        start: 1,
        sort: "random"
      });

      searches.push({
        query,
        searchType,
        results: mapLocalResults(data.items, { searchQuery: query, searchType })
      });
    } catch (error) {
      searchErrors.push({ query, message: error.message, status: error.status });
      if (error.message.includes("NAVER_CLIENT_ID")) {
        throw error;
      }
    }

    await sleep(NAVER_REQUEST_DELAY_MS);
  }

  const keywordResults = searches
    .filter((search) => search.searchType === "keyword")
    .flatMap((search) => search.results);
  const businessResults = searches
    .filter((search) => search.searchType === "business")
    .flatMap((search) => search.results);

  const dedupedKeywordResults = uniqueBy(
    keywordResults,
    (item) => `${item.title} ${item.roadAddress || item.address}`
  ).slice(0, 10);
  const placeRank = findPlaceRank(dedupedKeywordResults, businessName);
  const businessMatch =
    dedupedKeywordResults.find((item) => containsNeedle(item.title, businessName)) ||
    businessResults.find((item) => containsNeedle(item.title, businessName));

  const localResults = [...dedupedKeywordResults];
  if (businessMatch && !placeRank) {
    localResults.unshift({
      ...businessMatch,
      rank: null,
      rankLabel: "업체",
      matchNote: "업체명 검색으로 확인됨. 단, 현재 키워드 지역검색 공식 API 5위권에는 없습니다."
    });
  }

  return {
    placeRank,
    placeRankLabel: placeRank ? `${placeRank}위` : businessMatch ? "5위권밖" : "미노출",
    placeFoundByName: Boolean(businessMatch),
    localResults: localResults.slice(0, 6),
    localSearchQueries: queries,
    localSearchErrors: searchErrors
  };
}

function getBusinessMatchTerms(businessName, keyword = "", category = "") {
  const raw = String(businessName || "").trim();
  const regionTerms = GANGWON_REGIONS.flatMap((region) => region.aliases);
  const noiseWords = compactUnique([
    keyword,
    String(keyword || "").replace(/\s+/g, ""),
    category,
    String(category || "").replace(/\s+/g, ""),
    ...regionTerms,
    ...COMMON_CATEGORY_TERMS,
    "센터",
    "짐",
    "지점",
    "본점",
    "매장",
    "가게",
    "본사",
    "점",
    "FITNESS",
    "GYM",
    "PILATES"
  ]);
  const keywordCleaned = removeKeywordFromBusinessName(raw, keyword, category);
  const brandOnly = removeTermsFromText(keywordCleaned, noiseWords) || keywordCleaned;
  const sourceTexts = compactUnique([
    brandOnly,
    keywordCleaned,
    removeTermsFromText(raw, noiseWords)
  ]);
  const blockedTerms = noiseWords
    .map((word) => normalizeText(word))
    .filter((word) => word.length >= 2);
  const terms = [];

  sourceTexts.forEach((sourceText) => {
    const normalizedSource = normalizeText(sourceText);
    if (normalizedSource.length >= 2) {
      terms.push(sourceText);
      terms.push(normalizedSource);
    }

    sourceText
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const normalizedPart = normalizeText(part);
        if (normalizedPart.length >= 2) {
          terms.push(part);
          terms.push(normalizedPart);
        }
      });
  });

  return compactUnique(terms)
    .map((term) => normalizeText(term))
    .filter((term) => {
      if (term.length < 2) return false;
      return !blockedTerms.some(
        (blocked) => term === blocked || (term.length <= blocked.length && blocked.includes(term))
      );
    });
}

function blogResultMatchesBusiness(item, businessName, keyword = "", category = "") {
  const content = `${item.title} ${item.description} ${item.bloggerName} ${item.link}`;
  const normalizedContent = normalizeText(content);
  const matchTerms = getBusinessMatchTerms(businessName, keyword, category);

  if (!matchTerms.length) return false;
  return matchTerms.some((term) => normalizedContent.includes(term));
}

function findBlogRankMatch(blogResults, businessName, primaryKeyword, category = "") {
  const match = blogResults.find((item) =>
    blogResultMatchesBusiness(item, businessName, primaryKeyword, category)
  );
  if (!match) return null;

  const primaryQueryMatch = normalizeText(match.searchQuery) === normalizeText(primaryKeyword);
  return {
    ...match,
    rankLabel: primaryQueryMatch ? `${match.rank}위` : `보조키워드 ${match.rank}위`
  };
}

async function analyzeBlogResults({ businessName, keyword, category, blogDisplay }) {
  const keywordQueries = compactUnique([keyword]).slice(0, 1);
  const queries = keywordQueries;
  const primaryDisplay = clampInteger(blogDisplay, 100, 10, 100);

  const searches = [];
  const searchErrors = [];
  for (const query of queries) {
    try {
      const data = await fetchNaverJson(NAVER_BLOG_URL, {
        query,
        display: primaryDisplay,
        start: 1,
        sort: "sim"
      });

      searches.push({
        query,
        searchType: "keyword",
        results: mapBlogResults(data.items, { searchQuery: query, searchType: "keyword" })
      });
    } catch (error) {
      searchErrors.push({ query, message: error.message, status: error.status });
      if (error.message.includes("NAVER_CLIENT_ID")) {
        throw error;
      }
    }
  }

  const keywordResults = searches.flatMap((search) => search.results);
  const primaryKeywordResults = keywordResults.filter(
    (item) => normalizeText(item.searchQuery) === normalizeText(keyword)
  );
  const allPrimaryKeywordResults = uniqueBy(
    primaryKeywordResults,
    (item) => item.link || `${item.title} ${item.bloggerName}`
  );

  /* 1순위: 통합검색 "인기글" 블록 (사용자가 네이버에서 검색했을 때 보이는 화면 그대로)
     2순위: 블로그탭 노출 순서
     3순위(아래 폴백): 공식 검색 API */
  let serpResults = [];
  let serpSource = "";
  try {
    serpResults = await fetchNaverPopularPosts(keyword, 30);
    serpSource = "naver-popular-block";
  } catch (error) {
    searchErrors.push({
      query: keyword,
      message: `통합검색 인기글 확인 실패: ${error.message}`,
      status: error.status || 0
    });
  }
  if (serpResults.filter((item) => !item.isSubPost).length < 3) {
    try {
      serpResults = await fetchNaverBlogTabResults(keyword, 30);
      serpSource = "naver-blog-tab";
    } catch (error) {
      serpResults = [];
      serpSource = "";
      searchErrors.push({
        query: keyword,
        message: `네이버 블로그탭 실제 화면 확인 실패: ${error.message}`,
        status: error.status || 0
      });
    }
  }
  const serpMainCount = serpResults.filter((item) => !item.isSubPost).length;

  if (serpMainCount >= 3) {
    /* 공식 API 결과와 링크가 겹치면 설명·블로거명을 가져와 보강한다 */
    const apiByLink = new Map(
      allPrimaryKeywordResults
        .filter((item) => item.link)
        .map((item) => [item.link.split("?")[0], item])
    );
    const enrichedResults = serpResults.map((item) => {
      const apiItem = apiByLink.get(item.link);
      return apiItem
        ? {
            ...item,
            description: apiItem.description || "",
            bloggerName: item.bloggerName || apiItem.bloggerName || "",
            postdate: apiItem.postdate || ""
          }
        : item;
    });
    /* 화면에는 대표글만 순서대로 보여주고, 업체 글 확인은 묶음글까지 모두 검사한다 */
    const mainResults = enrichedResults.filter((item) => !item.isSubPost);
    const ownBlogResults = enrichedResults
      .filter((item) => blogResultMatchesBusiness(item, businessName, keyword, category))
      .map((item) => ({
        rank: item.rank,
        rankLabel: item.isSubPost ? `${item.rank}위 묶음글` : `${item.rank}위`,
        title: item.title,
        description: item.description,
        bloggerName: item.bloggerName,
        link: item.link,
        searchQuery: item.searchQuery
      }));
    const blogRankMatch = ownBlogResults[0] || null;
    const basisLabel =
      serpSource === "naver-popular-block"
        ? `${keyword} 네이버 통합검색 인기글 실제 노출 순서 기준 (대표글 ${serpMainCount}개, 묶음글 포함 검사)`
        : `${keyword} 네이버 블로그탭 실제 노출 순서 기준 (상위 ${serpMainCount}개 확인)`;

    return {
      blogRank: blogRankMatch ? blogRankMatch.rank : null,
      blogRankLabel: blogRankMatch ? blogRankMatch.rankLabel : "미노출",
      blogRankSearchQuery: blogRankMatch ? blogRankMatch.searchQuery : "",
      blogRankBasis: basisLabel,
      blogRankSource: serpSource,
      ownBlogResult: blogRankMatch || null,
      ownBlogResults,
      blogVariantRank: null,
      blogVariantRankLabel: "",
      blogVariantRankSearchQuery: "",
      blogFoundByName: Boolean(blogRankMatch),
      keywordBlogResults: mainResults.slice(0, 10),
      blogResults: mainResults.slice(0, 10),
      blogContextResults: allPrimaryKeywordResults.length
        ? allPrimaryKeywordResults.slice(0, 10)
        : mainResults.slice(0, 10),
      businessBlogResults: [],
      blogSearchQueries: compactUnique([
        ...queries,
        serpSource === "naver-popular-block"
          ? `${keyword} (통합검색 인기글 실제 화면)`
          : `${keyword} (블로그탭 실제 화면)`
      ]),
      blogKeywordSearchQueries: keywordQueries,
      blogBusinessSearchQueries: [],
      blogSearchErrors: searchErrors
    };
  }

  /* 2순위(폴백): 실제 화면 확인이 막힌 경우 기존 공식 검색 API 기준 */
  const dedupedPrimaryKeywordResults = allPrimaryKeywordResults.slice(0, 10);
  const ownBlogResults = allPrimaryKeywordResults
    .filter((item) => blogResultMatchesBusiness(item, businessName, keyword, category))
    .map((item) => ({
      rank: item.rank,
      rankLabel: `${item.rank}위`,
      title: item.title,
      description: item.description,
      bloggerName: item.bloggerName,
      link: item.link,
      searchQuery: item.searchQuery
    }));
  const blogRankMatch = ownBlogResults[0] || null;

  return {
    blogRank: blogRankMatch ? blogRankMatch.rank : null,
    blogRankLabel: blogRankMatch ? blogRankMatch.rankLabel : "미노출",
    blogRankSearchQuery: blogRankMatch ? blogRankMatch.searchQuery : "",
    blogRankBasis: `${keyword} 공식 검색 API 결과 최대 ${primaryDisplay}개 기준 (실제 화면 확인 실패로 대체)`,
    blogRankSource: "openapi",
    ownBlogResult: blogRankMatch || null,
    ownBlogResults,
    blogVariantRank: null,
    blogVariantRankLabel: "",
    blogVariantRankSearchQuery: "",
    blogFoundByName: Boolean(blogRankMatch),
    keywordBlogResults: dedupedPrimaryKeywordResults,
    blogResults: dedupedPrimaryKeywordResults,
    blogContextResults: dedupedPrimaryKeywordResults,
    businessBlogResults: [],
    blogSearchQueries: queries,
    blogKeywordSearchQueries: keywordQueries,
    blogBusinessSearchQueries: [],
    blogSearchErrors: searchErrors
  };
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

function calculateTopBlogScore({ blogResults, keyword, category }) {
  const topBlog = Array.isArray(blogResults) && blogResults.length ? blogResults[0] : null;
  const topFive = Array.isArray(blogResults) ? blogResults.slice(0, 5) : [];
  const topOneText = topBlog
    ? `${topBlog.title} ${topBlog.description} ${topBlog.bloggerName}`
    : "";
  const topFiveText = topFive
    .map((item) => `${item.title} ${item.description} ${item.bloggerName}`)
    .join("\n");
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
  const checks = {
    topBlogExists: Boolean(topBlog),
    topTitleKeyword: topBlog ? containsNeedle(topBlog.title, keyword) : false,
    topDescriptionKeyword: topBlog ? containsNeedle(topBlog.description, keyword) : false,
    topFiveKeyword: containsNeedle(topFiveText, keyword),
    categoryKeyword: category ? containsNeedle(topFiveText, category) : false,
    articleWordCount: countIncludedWords(topFiveText, articleWords),
    structureWordCount: countIncludedWords(topFiveText, structureWords),
    visitWordCount: countIncludedWords(topFiveText, visitWords),
    richTopBlogContext: topFive.length >= 5
  };

  if (checks.topBlogExists) score += 10;
  if (checks.topTitleKeyword) score += 20;
  else if (checks.topFiveKeyword) score += 10;
  if (checks.topDescriptionKeyword) score += 15;
  if (checks.categoryKeyword) score += 5;

  score += Math.min(20, checks.articleWordCount * 3);
  score += Math.min(15, checks.structureWordCount * 3);
  score += Math.min(10, checks.visitWordCount * 5);
  if (checks.richTopBlogContext) score += 5;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    checks,
    title: topBlog ? topBlog.title : "",
    description: topBlog ? topBlog.description : ""
  };
}

function getPrimaryRegion(keyword) {
  const region = findGangwonRegions(keyword)[0];
  if (region) return region.base;

  const match = String(keyword || "").match(/^([\uac00-\ud7a3]{2,4})(헬스장|헬스|피트니스|PT|피티|운동)/i);
  return match ? match[1] : "";
}

function buildRecommendedKeywords({ businessName, keyword, category, blogResults, localResults }) {
  const region = getPrimaryRegion(keyword);
  const primaryTerm = getPrimaryFitnessTerm(keyword, category);
  const baseKeywords = buildKeywordVariants({ keyword, category });
  const topBlogText = blogResults
    .slice(0, 8)
    .map((item) => `${item.title} ${item.description}`)
    .join(" ");
  const topPlaceText = localResults
    .slice(0, 6)
    .map((item) => `${item.title} ${item.category} ${item.roadAddress || item.address}`)
    .join(" ");

  const intentWords = [
    "후기",
    "추천",
    "가격",
    "시설",
    "위치",
    "리뷰",
    "상담",
    "초보",
    "다이어트",
    "운동",
    "PT",
    "피티"
  ];
  const foundIntentWords = intentWords.filter((word) =>
    containsNeedle(`${topBlogText} ${topPlaceText} ${keyword} ${category}`, word)
  );
  const contentWords = compactUnique([
    ...foundIntentWords,
    "방문",
    "상담",
    "시설",
    "위치",
    "리뷰",
    "초보",
    "운동 루틴",
    "네이버 지도",
    "스마트플레이스"
  ]).slice(0, 12);

  const primary = compactUnique([
    keyword,
    ...baseKeywords,
    region && primaryTerm ? `${region}${primaryTerm}` : "",
    region && primaryTerm ? `${region} ${primaryTerm}` : ""
  ]).slice(0, 10);

  const longTail = compactUnique([
    `${keyword} 후기`,
    `${keyword} 추천`,
    `${keyword} 가격`,
    `${keyword} 시설`,
    `${keyword} 위치`,
    `${keyword} 리뷰`,
    `${keyword} PT`,
    `${keyword} 피티`,
    `${keyword} 초보`,
    `${keyword} 다이어트`,
    region ? `${region} 헬스장 추천` : "",
    region ? `${region} PT 상담` : ""
  ]).slice(0, 12);

  const placeKeywords = compactUnique([
    businessName,
    `${businessName} ${keyword}`,
    `${businessName} 후기`,
    `${businessName} 상담`,
    `${businessName} 위치`,
    `${businessName} 리뷰`,
    `${businessName} PT`,
    `${businessName} 피티`
  ]).slice(0, 8);

  const titleKeywords = compactUnique([
    `${keyword} 찾는다면`,
    `${keyword} 방문 후기`,
    `${keyword} 선택 기준`,
    `${keyword} 초보 상담`,
    `${businessName} ${keyword}`,
    `${businessName} 방문 전 체크`
  ]).slice(0, 8);

  const related = compactUnique([
    ...baseKeywords,
    region ? `${region} 헬스` : "",
    region ? `${region} 헬스장` : "",
    region ? `${region} 피트니스` : "",
    region ? `${region} PT` : "",
    region ? `${region} 피티` : "",
    region ? `${region} 운동` : "",
    region ? `${region} 다이어트` : "",
    region ? `${region} 체형관리` : "",
    region ? `${region} 근력운동` : "",
    region ? `${region} 헬스장 가격` : "",
    region ? `${region} 헬스장 시설` : "",
    region ? `${region} 헬스장 리뷰` : ""
  ]).slice(0, 14);

  const nextPlanKeywords = compactUnique([
    `${keyword} 후기`,
    `${keyword} 가격`,
    `${keyword} 시설`,
    `${keyword} 초보`,
    `${keyword} PT`,
    `${keyword} 다이어트`,
    `${keyword} 운동 루틴`,
    region ? `${region} 피트니스 추천` : "",
    region ? `${region} PT 상담` : "",
    region ? `${region} 헬스장 비교` : ""
  ]).slice(0, 8);

  const nextPlan = nextPlanKeywords.map((nextKeyword, index) => ({
    keyword: nextKeyword,
    reason:
      index < 3
        ? "메인 키워드와 바로 이어지는 검색 의도라서 다음 글 주제로 쓰기 좋습니다."
        : "상담, 시설, 가격, 후기처럼 방문 전환에 가까운 세부 의도를 보강할 수 있습니다.",
    contentAngle: [
      `${nextKeyword}를 찾는 사람이 가장 궁금해하는 방문 전 체크포인트`,
      `${businessName} 기준 시설, 위치, 상담, 운동 목적을 비교하는 방식`,
      "네이버 지도와 스마트플레이스 확인으로 이어지는 자연스러운 마무리"
    ].join(" / ")
  }));

  const writingStrategy = [
    "상위 블로그보다 더 이기려면 제목만 키워드로 맞추지 말고, 첫 350자 안에 지역명, 업종, 방문 이유, 업체명을 함께 넣어야 합니다.",
    "본문은 3000자 이상으로 작성하고 시설, 위치, 가격, 상담, 후기, 초보, PT, 피티, 다이어트, 운동 루틴을 소제목별로 나눠 정보 밀도를 높입니다.",
    "상위 글을 그대로 따라 쓰지 말고 방문 전 체크리스트, 비교 기준, 상담 전 질문, 네이버 지도 확인 문장까지 넣어 플레이스 전환 근거를 강화합니다."
  ];

  return {
    primary,
    longTail,
    place: placeKeywords,
    content: contentWords,
    titles: titleKeywords,
    related,
    next: nextPlanKeywords,
    nextPlan,
    writingStrategy
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

function calculateTotalScore({ placeRank, blogRank, blogScore, placeFoundByName }) {
  const placeComponent = rankScore(placeRank, 30);
  const blogRankComponent = rankScore(blogRank, 25);
  const blogQualityComponent = Math.round(blogScore * 0.35);
  const exposureComponent = placeRank ? 10 : placeFoundByName ? 4 : 0;

  return Math.min(
    100,
    placeComponent + blogRankComponent + blogQualityComponent + exposureComponent
  );
}

function createActions({
  placeRank,
  blogRank,
  blogScore,
  businessName,
  keyword,
  category,
  placeFoundByName
}) {
  const actions = [];

  if (!placeRank) {
    if (placeFoundByName) {
      actions.push(`${businessName} 업체 정보는 확인됐지만 ${keyword} 공식 지역검색 5위권에는 없습니다.`);
      actions.push("네이버 공식 지역검색 API는 최대 5개 결과만 제공하므로, 5위권 진입 여부를 중심으로 관리하세요.");
    } else {
      actions.push(`${keyword} 지역 검색과 업체명 검색 모두에서 ${businessName} 노출을 먼저 확인하세요.`);
      actions.push("스마트플레이스 업체명, 카테고리, 주소, 대표 키워드 일치도를 점검하세요.");
    }
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

function createRankAnalysis({
  businessName,
  keyword,
  placeRank,
  placeRankLabel,
  placeFoundByName,
  blogRank,
  blogRankLabel,
  blogScore,
  blogFoundByName,
  localResults,
  blogResults
}) {
  const risks = [];
  const nextActions = [];
  const trackingMetrics = [
    "플레이스 키워드 순위",
    "실제 네이버 VIEW 노출 순서",
    "블로그 API 기준 노출 여부",
    "방문 예약/전화 문의 수",
    "이번 주 신규 리뷰 수"
  ];

  const placeStatus = placeRank
    ? `${placeRankLabel || `${placeRank}위`} 노출`
    : placeFoundByName
      ? "업체명 검색은 확인, 대표키워드 5위권 미노출"
      : "대표키워드와 업체명 검색 모두 보강 필요";

  const blogStatus = blogRank
    ? `${blogRankLabel || `${blogRank}위`} 노출`
    : blogFoundByName
      ? "업체명 블로그는 확인, 대표키워드 노출 보강 필요"
      : "대표키워드 블로그 노출 보강 필요";

  if (!placeRank) {
    risks.push("플레이스가 대표키워드 상위권에 잡히지 않으면 블로그에서 플레이스 클릭을 강하게 유도해야 합니다.");
    nextActions.push(`${keyword} 검색자가 바로 확인할 수 있도록 글 중간과 하단에 네이버 지도/플레이스 확인 문장을 넣으세요.`);
  } else if (placeRank > 3) {
    risks.push("플레이스는 보이지만 상위 3개 업체와 비교하면 클릭률 경쟁이 필요합니다.");
    nextActions.push("상위 플레이스의 카테고리, 업체명 문구, 리뷰 문맥을 비교해 스마트플레이스 정보를 보강하세요.");
  } else {
    nextActions.push("플레이스 상위 노출을 유지하기 위해 최신 후기형 블로그와 신규 리뷰를 꾸준히 쌓으세요.");
  }

  if (!blogRank) {
    risks.push("네이버 공식 블로그 API 기준으로 업체명 포함 글이 대표키워드 결과에 잡히지 않습니다.");
    nextActions.push(`${businessName}과 ${keyword}를 제목, 첫 문단, 소제목, 마무리 문장에 자연스럽게 배치한 4000자 이상 글을 발행하세요.`);
  } else if (blogRank > 5) {
    risks.push("블로그가 보이더라도 클릭을 가져오는 상위 구간은 아직 아닐 수 있습니다.");
    nextActions.push("상위 블로그보다 사진 동선, 상담 기준, 초보자 질문, 실제 방문 후기를 더 구체적으로 보강하세요.");
  } else {
    nextActions.push("현재 블로그 노출 흐름을 유지하면서 같은 키워드의 후기형 보조 글을 추가 발행하세요.");
  }

  if (blogScore < 70) {
    risks.push("상위 블로그 문맥 점수가 낮아 글 구조, 방문 의도, 플레이스 전환 문구 보강이 필요합니다.");
    nextActions.push("후기, 추천, 가격, 시설, 위치, 리뷰, 초보, PT, 피티, 상담, 방문 문맥을 본문 안에 분산 배치하세요.");
  }

  const competitorCount = Array.isArray(localResults) ? localResults.length : 0;
  const blogCount = Array.isArray(blogResults) ? blogResults.length : 0;
  const level =
    placeRank && placeRank <= 3 && blogRank && blogRank <= 5 && blogScore >= 75
      ? "상위 유지 구간"
      : placeRank || blogRank || blogScore >= 60
        ? "상승 준비 구간"
        : "초기 보강 구간";

  return {
    level,
    summary: `${keyword} 기준 현재 상태는 ${level}입니다. 플레이스는 ${placeStatus}, 블로그는 ${blogStatus}입니다.`,
    placeStatus,
    blogStatus,
    competitorCount,
    blogCount,
    risks: risks.slice(0, 4),
    nextActions: nextActions.slice(0, 5),
    trackingMetrics
  };
}

function buildExpertBlogRules({ businessName, keyword, category, isTreatraum }) {
  const facts = isTreatraum
    ? [
        "트리트라움 실제 정보는 다음 범위 안에서만 사용한다.",
        "- 24시간 365일 운영",
        "- 머신 47개와 AI운동박사 앱 연동",
        "- 주소: 강원 동해시 동굴로 125-3 현진관광호텔 13F",
        "- 상담: 010-8343-0646",
        "- 공식 사이트: https://www.treetaum.com/",
        "- 카카오톡 채널: pf.kakao.com/_vxosqK",
        "- AI운동솔루션, 프리미엄 머신 gym80, 요가와 필라테스 통합 웰니스센터라는 차별점을 자연스럽게 사용한다.",
        "위 정보 외 가격, 회원 수, 시설 수치, 이벤트 조건은 지어내지 않는다."
      ]
    : [
        "업체 실제 정보가 부족하면 가격, 이벤트, 수치, 후기 인물은 지어내지 않는다.",
        "확실하지 않은 정보는 방문 전 플레이스에서 확인하면 좋다는 방식으로 자연스럽게 처리한다."
      ];

  return [
    "[블로그 작성 최상위 규칙]",
    "당신은 네이버 플레이스 SEO 전문가이자 지역 헬스장 마케팅 컨설턴트다.",
    isTreatraum
      ? "화자는 동해 트리트라움 5년차 트레이너처럼 말한다. 과장된 광고문이 아니라 실제로 상담하고 안내하는 사람의 자연스러운 존댓말로 쓴다."
      : "화자는 해당 지역에서 실제 고객을 상담하는 피트니스 전문가처럼 말한다. 과장된 광고문이 아니라 자연스러운 존댓말로 쓴다.",
    "목표는 단순 조회수가 아니라 네이버 플레이스 클릭 증가, 플레이스 체류시간 증가, 전화문의 증가, 방문예약 증가, 회원등록 증가다.",
    "대표키워드 검색 후 블로그를 읽은 사람이 플레이스를 클릭하고 상담이나 방문예약까지 이어지게 작성한다.",
    "",
    "[문체]",
    "첫 문장은 고객 고민으로 시작한다. '오늘은 알아보겠습니다' 같은 AI 문체는 절대 쓰지 않는다.",
    "문장은 짧고 리듬 있게 쓴다. 번역체, 딱딱한 보고서체, 근거 없는 확정 표현을 피한다.",
    "정보성 70%, 홍보성 30% 비율로 작성한다.",
    "상위 블로그 문장을 복사하지 말고, 구조와 검색 의도만 참고해 더 깊고 자연스럽게 새로 쓴다.",
    "",
    "[SEO 구조]",
    `제목은 ${keyword}를 앞쪽에 포함하고 25자에서 40자 사이로 만든다.`,
    `본문은 최소 ${AI_TARGET_MIN_CHARS}자 이상으로 작성한다.`,
    `대표키워드 '${keyword}'는 본문 안에 8회에서 12회 자연스럽게 넣는다.`,
    `업체명 '${businessName}'은 본문 안에 5회 이상 자연스럽게 넣는다.`,
    "연관키워드는 최대 3개를 중심으로 사용하고, 키워드 나열처럼 보이지 않게 문장 안에 섞는다.",
    "소제목은 7개 이상 사용한다.",
    "본문 안에 FAQ 6개를 포함한다.",
    "해시태그는 8개에서 12개 사이로 작성한다.",
    "",
    "[본문 필수 흐름]",
    "도입부: 고객 검색 의도와 실제 고민을 짚는다.",
    "본문1: 운동 실패 이유를 의지 부족이 아니라 환경, 구조, 루틴 관점으로 설명한다.",
    "본문2: 대표키워드 선택 기준을 접근성, 시설, 머신, 운동 시스템, 관리 기준으로 설명한다.",
    "본문3: 업체 장점은 광고처럼 쓰지 말고 실제 방문한 사람 시점으로 쓴다.",
    "본문4: 시설 사진만 보지 말고 직접 방문, 상담, 무료 체험, 시설 구경, 플레이스 예약으로 이어지게 쓴다.",
    "본문5: 처음 등록 당시, 1개월, 3개월 변화 흐름을 후기처럼 자연스럽게 구성한다.",
    "결론: 결국 꾸준히 할 수 있는 환경이 중요하다는 말로 부드럽게 마무리한다.",
    "",
    "[플레이스 전환 문구]",
    "아래 의미를 본문 중간에 자연스럽게 변형해서 넣는다.",
    "시설 사진만 보지 말고 직접 방문해보세요.",
    "상담만 받아도 운동 방향이 달라질 수 있습니다.",
    "플레이스 예약 후 방문하면 더욱 편하게 상담 가능합니다.",
    "",
    "[출력 제한]",
    "네이버 블로그에 바로 붙여넣을 수 있는 일반 텍스트로만 작성한다.",
    "마크다운 문법을 절대 쓰지 않는다. 샵(#) 기호로 시작하는 소제목, 별표 강조, 코드블록 같은 형식을 사용하지 않는다.",
    "소제목은 '1. 운동 실패 이유는 의지보다 환경입니다'처럼 일반 문장으로 쓴다.",
    "본문 중간중간 사진이 필요한 위치에는 빈 줄을 두고 '[사진을 넣어주세요: 헬스장 입구 또는 외관 사진]'처럼 표시한다.",
    "사진 안내 문구는 본문 안에 최소 5개 넣는다. 외관, 시설 내부, 대표 머신, 상담 공간, 네이버 플레이스 예약 화면을 각각 넣을 위치를 표시한다.",
    "본문 중간에 짧은 인용구형 강조 문장을 3개 넣는다.",
    "인용구는 “운동을 오래 못 한 이유는 의지가 약해서가 아니라, 나에게 맞는 환경을 아직 못 찾았기 때문일 수 있습니다.”처럼 큰따옴표 문장으로만 쓴다.",
    "인용구에 >, ##, ** 같은 마크다운 기호를 절대 쓰지 않는다.",
    "출력은 제목, 본문, 해시태그 순서로만 한다.",
    "프롬프트 설명, 분석 과정, 작성 전략, 이미지 생성 안내, 다운로드 안내는 출력하지 않는다.",
    ...facts
  ].join("\n");
}

function createPrompt({
  businessName,
  keyword,
  category,
  blogScore,
  placeRank,
  blogRank,
  blogRankLabel,
  placeRankLabel,
  recommendedKeywords
}) {
  const keywordText = recommendedKeywords
    ? [
        `핵심 키워드: ${recommendedKeywords.primary.join(", ")}`,
        `롱테일 키워드: ${recommendedKeywords.longTail.join(", ")}`,
        `업체 키워드: ${recommendedKeywords.place.join(", ")}`,
        `본문 문맥 키워드: ${recommendedKeywords.content.join(", ")}`,
        `연관 키워드: ${recommendedKeywords.related.join(", ")}`,
        `다음 추천 키워드: ${recommendedKeywords.next.join(", ")}`
      ].join("\n")
    : "";
  const isFitnessCategory = hasFitnessIntent(keyword, category);
  const isTreatraum = normalizeText(businessName).includes(normalizeText("트리트라움"));
  const differentiators = isTreatraum
    ? [
        "AI운동솔루션",
        "프리미엄 머신 gym80",
        "요가·필라테스 통합 웰니스센터",
        "헬스, PT, 피티, 다이어트, 체형관리까지 한 번에 비교 가능한 운동 공간"
      ]
    : [
        `${businessName}의 실제 시설과 이용 동선`,
        "상담 방식",
        "초보자도 방문 전 확인할 수 있는 이용 기준",
        `${category || "업종"} 선택 시 비교해야 할 장점`
      ];

  return [
    buildExpertBlogRules({ businessName, keyword, category, isTreatraum }),
    "",
    isFitnessCategory
      ? "당신은 네이버 플레이스 SEO 전문가이자 지역 헬스장 마케팅 컨설턴트이다."
      : `당신은 네이버 플레이스 SEO 전문가이자 지역 ${category || "로컬 비즈니스"} 마케팅 컨설턴트이다.`,
    "",
    "목표는 단순 블로그 조회수가 아니다.",
    "목표는 네이버 플레이스 클릭 증가, 플레이스 체류시간 증가, 전화문의 증가, 방문예약 증가, 회원등록 증가이다.",
    "",
    "[입력값]",
    `업체명: ${businessName}`,
    `대표키워드: ${keyword}`,
    `업종: ${category || "미입력"}`,
    `현재 플레이스 순위: ${placeRank ? `${placeRank}위` : placeRankLabel || "미노출"}`,
    `현재 블로그 순위: ${blogRank ? blogRankLabel || `${blogRank}위` : "미노출"}`,
    `현재 블로그 글 품질 점수: ${blogScore}점`,
    keywordText ? `\n자동 추천 키워드\n${keywordText}` : "",
    "",
    "[최우선 목표]",
    "대표키워드 검색 시 블로그에서 네이버 플레이스 클릭으로 이어지게 작성한다.",
    "글의 목적은 조회수가 아니라 플레이스 유입, 상담, 예약, 등록 전환이다.",
    "",
    "[글자수]",
    `최소 ${AI_TARGET_MIN_CHARS}자 이상 작성한다.`,
    "",
    "[제목 규칙]",
    "제목에는 반드시 대표키워드를 포함한다.",
    "제목은 검색자가 클릭하고 싶은 문제 해결형 또는 확인형으로 쓴다.",
    `예시: ${keyword} 등록 전 꼭 확인해야 하는 7가지`,
    `예시: ${keyword} 찾는다면 시설보다 중요한 것은?`,
    `예시: ${keyword} 선택할 때 대부분 놓치는 부분`,
    `예시: ${keyword} 운동 초보가 실패하지 않는 방법`,
    "",
    "[도입부]",
    "고객 검색의도를 바로 건드린다.",
    `${keyword} 알아보는 분들이 가장 많이 하는 질문이 있습니다.`,
    "\"어디를 등록해야 오래 다닐 수 있을까요?\"",
    "\"PT를 받아야 할까요?\"",
    "\"운동을 전혀 모르는데 가능할까요?\"",
    "실제로 많은 분들이 이 고민을 합니다.",
    "위 흐름처럼 시작하되 문장은 자연스럽게 새로 작성한다.",
    "",
    "[본문 구성]",
    "본문1: 왜 운동에 실패하는가. 의지 부족이 아니라 환경, 구조, 루틴 문제라는 관점으로 설명한다.",
    `본문2: ${keyword} 선택 기준을 접근성, 시설, 머신, 운동 시스템, 관리 기준으로 설명한다.`,
    "본문3: 업체 장점을 광고처럼 쓰지 말고 실제 방문한 사람 시점으로 쓴다. '제가 가장 놀랐던 부분은', '처음 들어가자마자', '다른 곳과 달랐던 점은' 같은 후기형 흐름을 활용한다.",
    "본문4: 플레이스 방문 유도 문단을 반드시 넣는다. 시설 사진만 보지 말고 직접 방문해보기, 상담 받아보기, 무료 체험, 시설 구경, 상담 가능 흐름을 자연스럽게 삽입한다.",
    "본문5: 실제 회원 변화 사례를 후기처럼 구성한다. 처음 등록 당시, 1개월, 3개월 변화를 구체적으로 보여준다.",
    "결론: 광고처럼 끝내지 말고 꾸준히 할 수 있는 환경의 중요성으로 마무리한다.",
    "",
    "[업체 차별점]",
    ...differentiators.map((item) => `- ${item}`),
    "",
    "[SEO 규칙]",
    `대표키워드 '${keyword}'는 본문 내 8~12회 자연스럽게 삽입한다.`,
    `업체명 '${businessName}'은 5회 이상 자연스럽게 삽입한다.`,
    "연관키워드를 자동 생성해 본문과 해시태그에 자연스럽게 반영한다.",
    `예시: ${keyword}, 지역 PT, 지역 다이어트, 지역 운동, 지역 피트니스, 지역 헬스`,
    "",
    "[플레이스 전환 문구]",
    "본문 중간에 아래 문장을 자연스럽게 변형해 넣는다.",
    "시설 사진만 보지 말고 직접 방문해보세요.",
    "상담만 받아도 운동 방향이 달라질 수 있습니다.",
    "플레이스 예약 후 방문하면 더욱 편하게 상담 가능합니다.",
    "",
    "[톤앤매너]",
    "광고 티를 최소화한다.",
    "정보성 콘텐츠 70%, 홍보성 콘텐츠 30% 비율로 작성한다.",
    "과장, 확정적 1등 보장, 허위 후기처럼 보이는 표현은 쓰지 않는다.",
    "실제 방문 후기처럼 자연스럽게 쓰되 플레이스 클릭 이유는 분명하게 만든다.",
    "",
    "출력 형식:",
    "제목:",
    "본문:",
    "해시태그:"
  ].join("\n");
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  output.forEach((item) => {
    const content = Array.isArray(item.content) ? item.content : [];
    content.forEach((contentItem) => {
      if (typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    });
  });

  const chatChoices = Array.isArray(data?.choices) ? data.choices : [];
  chatChoices.forEach((choice) => {
    if (typeof choice.message?.content === "string") {
      parts.push(choice.message.content);
    }
    if (Array.isArray(choice.message?.content)) {
      choice.message.content.forEach((contentItem) => {
        if (typeof contentItem.text === "string") {
          parts.push(contentItem.text);
        }
        if (typeof contentItem.content === "string") {
          parts.push(contentItem.content);
        }
      });
    }
    if (typeof choice.text === "string") {
      parts.push(choice.text);
    }
  });

  const extractedText = parts.join("\n").trim();
  if (extractedText) {
    return extractedText;
  }

  const directTextFields = [
    data?.text,
    data?.content,
    data?.result,
    data?.response,
    data?.message
  ];
  const directText = directTextFields.find((value) => typeof value === "string" && value.trim());
  return directText ? directText.trim() : "";
}

function cleanBlogDraftForPublishing(rawDraft) {
  let draft = String(rawDraft || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!draft) return draft;

  const quoteMarkers = [
    "“운동을 오래 못 한 이유는 의지가 약해서가 아니라, 나에게 맞는 환경을 아직 못 찾았기 때문일 수 있습니다.”",
    "“시설 사진보다 중요한 것은 내가 실제로 오래 다닐 수 있는 동선과 분위기인지 확인하는 것입니다.”",
    "“상담만 받아도 지금 내 몸에 맞는 운동 방향이 훨씬 선명해질 수 있습니다.”"
  ];
  const quoteCount = (draft.match(/["“][^"”\n]{18,}["”]/g) || []).length;
  if (quoteCount < 3) {
    const quoteLines = draft.split("\n");
    const quoteBodyIndex = quoteLines.findIndex((line) => /^본문\s*[:：]\s*$/.test(line.trim()));
    const firstQuoteAt = quoteBodyIndex >= 0 ? Math.min(quoteBodyIndex + 4, quoteLines.length) : Math.min(5, quoteLines.length);
    const missingQuotes = quoteMarkers.slice(quoteCount);
    quoteLines.splice(firstQuoteAt, 0, "", missingQuotes[0], "");

    const quoteSectionPatterns = [/^3[.)]\s*/, /^5[.)]\s*/];
    let quoteSearchFrom = firstQuoteAt + 1;
    quoteSectionPatterns.forEach((pattern, markerIndex) => {
      const marker = missingQuotes[markerIndex + 1];
      if (!marker) return;
      const foundIndex = quoteLines.findIndex((line, index) => index > quoteSearchFrom && pattern.test(line.trim()));
      if (foundIndex >= 0) {
        quoteLines.splice(foundIndex, 0, "", marker, "");
        quoteSearchFrom = foundIndex + 3;
      }
    });

    draft = quoteLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const hasPhotoMarker = /\[?\s*사진을\s*넣어주세요/i.test(draft);
  if (hasPhotoMarker) return draft;

  const photoMarkers = [
    "[사진을 넣어주세요: 헬스장 입구 또는 외관 사진]",
    "[사진을 넣어주세요: 시설 내부와 전체 운동 동선 사진]",
    "[사진을 넣어주세요: 대표 머신 또는 프리미엄 기구 사진]",
    "[사진을 넣어주세요: 상담 공간 또는 무료 체험 안내 사진]",
    "[사진을 넣어주세요: 네이버 플레이스 예약 화면 또는 지도 위치 캡처]"
  ];

  const lines = draft.split("\n");
  const bodyIndex = lines.findIndex((line) => /^본문\s*[:：]\s*$/.test(line.trim()));
  const insertAt = bodyIndex >= 0 ? Math.min(bodyIndex + 2, lines.length) : Math.min(3, lines.length);
  lines.splice(insertAt, 0, "", photoMarkers[0], "");

  const sectionPatterns = [/^2[.)]\s*/, /^3[.)]\s*/, /^4[.)]\s*/, /^7[.)]\s*|^결론/];
  let searchFrom = insertAt + 1;
  sectionPatterns.forEach((pattern, markerIndex) => {
    const foundIndex = lines.findIndex((line, index) => index > searchFrom && pattern.test(line.trim()));
    if (foundIndex >= 0) {
      lines.splice(foundIndex, 0, "", photoMarkers[markerIndex + 1], "");
      searchFrom = foundIndex + 3;
    }
  });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function postOpenAI(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(OPENAI_API_KEY ? { Authorization: `Bearer ${OPENAI_API_KEY}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    const timeoutError = new Error(
      error.name === "AbortError"
        ? "AI 원고 작성 시간이 길어져 요청을 중단했습니다."
        : error.message || "AI 원고 작성 서버 연결에 실패했습니다."
    );
    timeoutError.status = error.name === "AbortError" ? 504 : 502;
    throw timeoutError;
  } finally {
    clearTimeout(timeout);
  }

  const responseBody = await response.text();
  let data;
  try {
    data = JSON.parse(responseBody);
  } catch (error) {
    data = { error: { message: responseBody } };
  }

  if (!response.ok) {
    const apiError = new Error(
      data.error?.message || data.message || "AI 블로그 원고 생성에 실패했습니다."
    );
    apiError.status = response.status;
    apiError.details = data;
    throw apiError;
  }

  const text = extractOpenAIText(data);
  if (!text) {
    const emptyError = new Error("AI 응답은 왔지만 블로그 원고 내용이 비어 있습니다.");
    emptyError.status = 502;
    emptyError.details = data;
    throw emptyError;
  }

  return text;
}

async function createOpenAIBlogDraft({
  businessName,
  keyword,
  category,
  blogResults,
  localResults,
  blogScore,
  placeRankLabel,
  blogRank,
  normalizedInput,
  recommendedKeywords,
  writingPrompt
}) {
  if (!OPENAI_ENABLED) {
    const error = new Error(
      "AI 블로그 작성 서버가 연결되지 않았습니다. Render 환경변수에 OPENAI_CHAT_COMPLETIONS_URL 또는 OPENAI_API_KEY를 넣어주세요."
    );
    error.status = 503;
    throw error;
  }

  const topBlogs = blogResults.slice(0, AI_CONTEXT_RESULT_LIMIT).map((item) => ({
    rank: item.rank,
    title: item.title,
    description: item.description,
    bloggerName: item.bloggerName,
    postdate: item.postdate
  }));
  const competitors = localResults.slice(0, AI_CONTEXT_RESULT_LIMIT).map((item) => ({
    rank: item.rankLabel || item.rank,
    title: item.title,
    category: item.category,
    address: item.roadAddress || item.address,
    searchQuery: item.searchQuery
  }));

  const input = {
    businessName,
    keyword,
    category,
    placeRank: placeRankLabel || "미노출",
    blogRank: blogRank ? `${blogRank}위` : "미노출",
    topBlogSignalScore: blogScore,
    normalizedInput,
    recommendedKeywords,
    topBlogs,
    competitors
  };

  const instructions = [
    buildExpertBlogRules({
      businessName,
      keyword,
      category,
      isTreatraum: normalizeText(businessName).includes(normalizeText("트리트라움"))
    }),
    "",
    "너는 네이버 플레이스 SEO 전문가이자 지역 헬스장 마케팅 컨설턴트다.",
    "목표는 단순 블로그 조회수가 아니라 네이버 플레이스 클릭, 체류시간, 전화문의, 방문예약, 회원등록 증가다.",
    "사용자가 네이버 블로그에 바로 붙여넣어 발행할 수 있는 완성 원고를 작성한다.",
    "대표키워드 검색자가 블로그를 읽은 뒤 네이버 플레이스를 클릭하고 상담 또는 방문예약을 하고 싶게 만들어야 한다.",
    "네이버 공식 1등 보장처럼 단정하지 말고, 실제 방문 후기처럼 자연스럽고 신뢰감 있게 작성한다.",
    "상위 블로그의 문장을 복사하지 말고 제목 구조, 정보 순서, 방문 의도, 지역 키워드 문맥만 참고한다.",
    "업체명과 키워드는 사용자가 입력한 값과 recommendedKeywords만 기준으로 삼는다. 다른 지역이나 이전 기본값을 섞지 않는다.",
    "사용자가 선택한 추천 키워드가 있으면 그 키워드들을 중심으로 글 주제를 잡고, 제목은 AI가 새롭게 만든다. 미리 정해진 추천 제목을 그대로 쓰지 않는다.",
    `본문은 최소 ${AI_TARGET_MIN_CHARS}자 이상 작성한다. 3000자 근처에서 끝내지 말고 충분한 정보량을 확보한다.`,
    "대표키워드는 본문 안에 8~12회, 업체명은 5회 이상 자연스럽게 넣는다.",
    "소제목은 7개 이상 사용하고, 각 소제목 아래에는 실제 독자가 도움이 된다고 느낄 만큼 구체적인 설명을 넣는다.",
    "왜 운동에 실패하는지, 선택 기준, 업체 장점, 플레이스 방문 유도, 회원 변화 사례, 결론 흐름을 반드시 포함한다.",
    "시설, 접근성, 머신, 운동 시스템, 관리, 상담, 무료 체험, 시설 구경, 초보자 관점, PT/피티, 운동 루틴, 방문 전 체크, 네이버 지도 확인 흐름을 모두 자연스럽게 포함한다.",
    "정보성 70%, 홍보성 30% 비율을 유지한다.",
    "네이버 블로그에 바로 붙여넣을 수 있는 일반 텍스트로만 작성한다.",
    "마크다운 문법을 절대 쓰지 않는다. 샵(#) 기호로 시작하는 소제목, 별표 강조, 코드블록 같은 형식을 사용하지 않는다.",
    "소제목은 '1. 운동 실패 이유는 의지보다 환경입니다'처럼 숫자와 일반 문장으로 쓴다.",
    "본문 중간중간 사진이 필요한 위치에는 빈 줄을 두고 '[사진을 넣어주세요: 헬스장 입구 또는 외관 사진]'처럼 표시한다.",
    "사진 안내 문구는 본문 안에 최소 5개 넣는다. 외관, 시설 내부, 대표 머신, 상담 공간, 네이버 플레이스 예약 화면을 각각 넣을 위치를 표시한다.",
    "본문 중간에 짧은 인용구형 강조 문장을 3개 넣는다.",
    "인용구는 “시설 사진보다 중요한 것은 내가 오래 다닐 수 있는 환경인지 확인하는 것입니다.”처럼 큰따옴표 문장으로만 쓴다.",
    "인용구에 >, ##, ** 같은 마크다운 기호를 절대 쓰지 않는다.",
    "출력에는 분석 과정, 전략 설명, 키워드 목록 해설, 다음 추천 키워드 설명을 넣지 않는다.",
    "반드시 제목, 본문, 해시태그만 출력한다."
  ].join("\n");
  const userPrompt = [
    "아래는 화면의 자동 적용 프롬프트다. 이 조건을 그대로 적용해서 네이버 블로그 발행용 완성 원고를 작성해줘.",
    "",
    writingPrompt,
    "",
    "아래 JSON 데이터는 네이버 검색 API 분석 결과다. 상위 블로그와 경쟁 플레이스의 흐름을 참고하되 문장은 새로 작성해줘.",
    "",
    JSON.stringify(input),
    "",
    "반드시 아래 형식만 출력해. 다른 설명은 절대 넣지 마.",
    "제목:",
    "핵심 키워드와 업체명이 자연스럽게 들어간 블로그 제목 1개",
    "",
    "본문:",
    `최소 ${AI_TARGET_MIN_CHARS}자 이상의 완성형 블로그 본문. 소제목 7개 이상, 각 소제목 2문단 이상. 블로그에서 플레이스 클릭으로 이어지는 흐름으로 작성.`,
    "",
    "해시태그:",
    "네이버 블로그 태그로 쓸 키워드 10개 안팎"
  ].join("\n");
  const useChatCompletions = OPENAI_API_STYLE === "chat";
  const openAIUrl = useChatCompletions ? OPENAI_CHAT_COMPLETIONS_URL : OPENAI_RESPONSES_URL;
  const fullPrompt = `${instructions}\n\n${userPrompt}`;

  if (!useChatCompletions) {
    const draft = await postOpenAI(openAIUrl, {
      model: OPENAI_MODEL,
      instructions,
      input: userPrompt,
      max_output_tokens: AI_MAX_TOKENS
    });
    return cleanBlogDraftForPublishing(draft);
  }

  const messages = [
    { role: "system", content: instructions },
    { role: "user", content: userPrompt }
  ];
  const chatAttempts = [
    {
      model: OPENAI_MODEL,
      messages,
      max_tokens: AI_MAX_TOKENS
    },
    {
      model: OPENAI_MODEL,
      messages,
      max_completion_tokens: AI_MAX_TOKENS
    },
    {
      model: OPENAI_MODEL,
      messages
    },
    {
      model: OPENAI_MODEL,
      prompt: fullPrompt,
      max_tokens: AI_MAX_TOKENS
    },
    {
      model: OPENAI_MODEL,
      input: fullPrompt,
      max_tokens: AI_MAX_TOKENS
    }
  ];

  let lastError;
  for (const body of chatAttempts) {
    try {
      const draft = await postOpenAI(openAIUrl, body);
      return cleanBlogDraftForPublishing(draft);
    } catch (error) {
      lastError = error;
      if (error.status && error.status !== 400) {
        break;
      }
    }
  }

  throw lastError || new Error("AI 블로그 원고 생성에 실패했습니다.");
}

function createBlogDraft({
  businessName,
  keyword,
  category,
  blogResults,
  localResults,
  blogScore,
  placeRankLabel,
  blogRank,
  recommendedKeywords,
  selectedKeywords
}) {
  const safeCategory = category || "업종";
  const focusKeywords = Array.isArray(selectedKeywords) && selectedKeywords.length
    ? selectedKeywords.slice(0, 3)
    : [keyword];
  const focusKeyword = focusKeywords[0] || keyword;
  const titleOptions = [
    `${focusKeyword} 찾는 분들이 ${businessName} 방문 전에 보면 좋은 체크포인트`,
    `${focusKeyword} 등록 전 꼭 확인해야 하는 운동 환경 기준`,
    `${focusKeyword} 처음 알아볼 때 실패하지 않는 선택 기준`,
    `${focusKeyword} 운동 초보가 상담 전에 보면 좋은 현실적인 기준`,
    `${focusKeyword} 시설보다 먼저 확인해야 할 방문 체크리스트`
  ];
  const title = titleOptions[Math.floor(Math.random() * titleOptions.length)];
  const tagSource = recommendedKeywords
    ? compactUnique([
        ...focusKeywords,
        focusKeyword,
        ...recommendedKeywords.primary,
        ...recommendedKeywords.longTail,
        ...recommendedKeywords.place,
        ...recommendedKeywords.content
      ])
    : compactUnique([keyword, businessName, safeCategory, `${keyword} 후기`, `${keyword} 추천`]);
  const tags = tagSource.slice(0, 12).map((tag) => `#${normalizeText(tag) || tag}`);

  return [
    "제목:",
    title,
    "",
    "본문:",
    `${keyword}을 찾아보는 분들이라면 아마 단순히 가까운 ${safeCategory} 하나만 보고 결정하지는 않을 것입니다. 위치가 편한지, 시설은 깔끔한지, 처음 방문했을 때 상담을 부담 없이 받을 수 있는지, 실제로 꾸준히 다닐 수 있는 분위기인지까지 함께 보게 됩니다. 특히 운동을 오래 쉬었다가 다시 시작하려는 분이나 다이어트, 체형 관리, 근력 운동, PT 상담을 고민하는 분이라면 처음 선택이 꽤 중요합니다. 오늘은 ${businessName}을 기준으로 ${keyword}을 알아볼 때 어떤 점을 보면 좋은지 자연스럽게 정리해보겠습니다.`,
    "",
    "1. 검색하는 사람이 가장 먼저 궁금해하는 기준",
    "",
    `${keyword}을 검색하는 사람은 보통 이미 방문 의도가 어느 정도 있는 상태입니다. 단순히 이름만 훑어보는 것이 아니라 실제로 갈 만한 곳인지, 내 목적에 맞는지, 상담이나 이용 과정이 부담스럽지 않은지 확인하고 싶어합니다. 그래서 블로그 글에서는 업체명만 반복하기보다 방문 전 궁금증을 하나씩 풀어주는 흐름이 중요합니다. ${businessName}을 알아보는 분들도 위치, 시설, 가격 확인 방법, 후기, 상담 방식, 초보자 이용 가능 여부를 함께 비교하면 선택이 훨씬 쉬워집니다.`,
    "",
    "2. 위치와 생활 동선",
    "",
    `처음 ${safeCategory}을 고를 때 가장 먼저 보게 되는 것은 거리와 위치입니다. 아무리 시설이 좋아도 생활 동선에서 너무 멀면 오래 다니기 어렵습니다. 반대로 집이나 직장 근처에서 부담 없이 방문할 수 있고, 운동 전후로 이동 시간이 길지 않다면 꾸준히 루틴을 만들기 훨씬 좋습니다. ${businessName}을 알아보는 분들도 네이버 지도에서 위치를 먼저 확인하고, 내가 자주 이동하는 길과 맞는지 살펴보면 선택이 쉬워집니다.`,
    "",
    "위치는 단순히 가까운지만 볼 것이 아니라 주차, 대중교통, 퇴근 후 이동, 주말 방문 편의성까지 같이 보는 것이 좋습니다. 특히 처음 방문하는 곳이라면 길찾기가 쉬운지, 주변에 함께 이용할 수 있는 편의시설이 있는지, 방문 시간대에 이동이 복잡하지 않은지도 실제 만족도에 영향을 줍니다.",
    "",
    "3. 시설과 이용 동선",
    "",
    "시설을 볼 때는 기구가 많다는 말만으로 판단하기보다 실제 운동 동선이 편한지 확인하는 것이 좋습니다. 유산소 운동을 먼저 하는 분이라면 러닝머신이나 사이클 공간이 충분한지, 웨이트를 중심으로 운동하는 분이라면 자주 쓰는 머신과 프리웨이트 공간이 잘 나뉘어 있는지 보는 것이 중요합니다. 초보자라면 기구 사용법을 물어보기 편한 분위기인지도 체크해야 합니다. 운동을 처음 시작할수록 작은 부담감이 꾸준함을 방해할 수 있기 때문입니다.",
    "",
    "좋은 시설은 화려한 사진만으로 판단하기 어렵습니다. 실제로는 청결 상태, 기구 간격, 탈의실과 샤워 공간, 피크 시간대 혼잡도, 처음 방문했을 때 직원이나 트레이너에게 질문하기 편한 분위기가 더 중요할 때가 많습니다. 이런 부분은 네이버 리뷰와 방문 후기를 함께 보면 조금 더 현실적으로 파악할 수 있습니다.",
    "",
    "4. 상담과 PT를 볼 때 중요한 점",
    "",
    `${keyword}을 검색하는 분들 중에는 PT나 피티 상담을 함께 고민하는 경우도 많습니다. 이때 중요한 것은 무조건 강도 높은 운동을 시작하는 것이 아니라, 현재 체력과 목표를 먼저 확인하는 과정입니다. 다이어트가 목표인지, 근력 증가가 목표인지, 자세 교정이나 체형 관리가 필요한지에 따라 운동 루틴은 달라집니다. ${businessName}에서 상담을 생각하고 있다면 첫 방문 때 운동 경험, 원하는 변화, 가능한 방문 횟수, 평소 생활 패턴을 함께 이야기해보는 것이 좋습니다.`,
    "",
    "상담을 받을 때는 프로그램 설명만 듣기보다 내 상황에 맞춰 어떤 방식으로 진행되는지 확인하는 것이 좋습니다. 예를 들어 운동을 처음 시작하는 사람이라면 기본 자세와 기구 사용법, 무리하지 않는 루틴이 중요하고, 체중 감량이 목표라면 식단 관리와 유산소, 근력 운동의 균형이 필요합니다. 목적이 분명할수록 상담도 구체적으로 받을 수 있습니다.",
    "",
    "5. 가격을 비교할 때 놓치기 쉬운 부분",
    "",
    "가격도 많은 분들이 궁금해하는 부분입니다. 하지만 헬스장은 가격만 보고 고르면 오래 다니기 어려울 수 있습니다. 내가 실제로 자주 갈 수 있는 위치인지, 시설 관리가 잘 되는지, 운동 목적에 맞는 안내를 받을 수 있는지, 리뷰에서 꾸준히 다니기 좋다는 이야기가 있는지까지 같이 봐야 합니다. 가격은 선택 기준 중 하나이지만, 꾸준히 운동할 수 있는 환경인지가 더 중요한 기준이 될 수 있습니다.",
    "",
    "가격을 확인할 때는 월 이용권, 기간권, PT 상담, 이벤트 여부처럼 실제 선택에 필요한 정보를 나눠서 보는 것이 좋습니다. 다만 온라인 글만으로 모든 조건이 고정되어 있다고 생각하기보다, 방문 전 네이버 스마트플레이스나 전화 상담을 통해 현재 기준을 확인하는 편이 안전합니다.",
    "",
    "6. 초보자라면 이렇게 시작하는 것이 좋습니다",
    "",
    "초보자라면 첫날부터 모든 것을 완벽하게 하려고 하기보다 가볍게 시작하는 것이 좋습니다. 처음에는 유산소 운동과 기본 머신 몇 가지로 몸을 적응시키고, 이후에 하체, 등, 가슴, 어깨처럼 부위를 나누어 루틴을 잡아가면 부담이 덜합니다. 혼자 운동하다가 자세가 불안하거나 어떤 순서로 해야 할지 모르겠다면 상담을 통해 내 몸 상태에 맞는 방향을 잡는 것도 좋은 방법입니다.",
    "",
    "운동을 오래 쉬었던 분이라면 첫 2주 정도는 강도를 높이기보다 방문 습관을 만드는 데 집중하는 것이 좋습니다. 짧게라도 꾸준히 방문하면서 몸이 적응하면 이후 운동 시간과 강도를 조금씩 늘리기 쉽습니다. 이런 흐름은 다이어트, 체력 회복, 근력 증가 모두에 도움이 됩니다.",
    "",
    "7. 방문 전 네이버에서 확인하면 좋은 것",
    "",
    `${businessName}을 방문하기 전에는 네이버 지도나 스마트플레이스에서 운영시간, 위치, 리뷰를 확인해보는 것을 추천합니다. 실제 방문자 리뷰는 시설 분위기나 이용 편의성을 파악하는 데 도움이 됩니다. 또 내가 방문하려는 시간대가 붐비는지, 상담은 어떤 방식으로 가능한지, 초보 운동 상담이나 PT 문의가 가능한지도 미리 확인하면 첫 방문이 훨씬 편해집니다.`,
    "",
    "운동을 꾸준히 하기 위해서는 시작할 때의 부담을 낮추는 것이 중요합니다. 처음부터 거창한 목표를 세우기보다 일주일에 몇 번 방문할지, 어떤 시간대가 편한지, 어떤 운동부터 시작할지 정해두면 좋습니다. 다이어트가 목표라면 식단과 유산소, 근력 운동을 함께 고려해야 하고, 체형 관리가 목표라면 자세와 근육 밸런스를 함께 보는 것이 좋습니다. 이런 부분을 혼자 정하기 어렵다면 상담을 통해 방향을 잡아보는 것도 도움이 됩니다.",
    "",
    `${keyword}을 비교할 때는 시설 사진만 보는 것보다 실제로 내가 어떤 목적을 가지고 다닐지 생각해보는 것이 좋습니다. 운동을 처음 시작하는 사람, 다시 루틴을 만들고 싶은 사람, PT나 피티를 통해 목표를 빠르게 잡고 싶은 사람은 각각 필요한 기준이 다릅니다. ${businessName}을 알아보고 있다면 위치, 시설, 상담, 리뷰, 운동 목적과의 적합도를 함께 체크해보세요.`,
    "",
    "마지막으로 방문 전에는 네이버 지도에서 길찾기와 위치를 확인하고, 스마트플레이스에서 운영시간과 리뷰를 한 번 더 보는 것을 추천합니다. 상담을 원한다면 가능한 시간대를 미리 확인해두면 좋고, 운동복이나 실내화 등 필요한 준비물이 있는지도 체크해두면 첫 방문이 더 편합니다. 결국 좋은 헬스장은 한 번 방문하기 좋은 곳이 아니라 꾸준히 다니기 좋은 곳입니다. 내 생활 패턴과 목표에 맞는지 천천히 비교해보면 더 만족스러운 선택을 할 수 있습니다.",
    "",
    "해시태그:",
    tags.join(" ")
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
    const normalizedInput = normalizeAnalyzeInput({
      businessName: req.body.businessName,
      keyword: req.body.keyword,
      category: req.body.category
    });
    const { businessName, keyword, category } = normalizedInput;

    if (!businessName || !keyword) {
      return res.status(400).json({
        message: "businessName과 keyword는 필수 입력값입니다."
      });
    }

    const [localAnalysis, blogAnalysisResults] = await Promise.all([
      analyzeLocalResults({
        businessName,
        keyword,
        category,
        localDisplay: req.query.localDisplay
      }),
      analyzeBlogResults({
        businessName,
        keyword,
        category,
        blogDisplay: req.query.blogDisplay
      })
    ]);

    const localResults = localAnalysis.localResults;
    const blogResults = blogAnalysisResults.blogResults;
    const placeRank = localAnalysis.placeRank;
    const blogRank = blogAnalysisResults.blogRank;
    const blogAnalysis = calculateTopBlogScore({ blogResults, keyword, category });
    const blogScore = blogAnalysis.score;
    const totalScore = calculateTotalScore({
      placeRank,
      blogRank,
      blogScore,
      placeFoundByName: localAnalysis.placeFoundByName
    });
    const actions = createActions({
      placeRank,
      blogRank,
      blogScore,
      businessName,
      keyword,
      category,
      placeFoundByName: localAnalysis.placeFoundByName
    });
    const rankAnalysis = createRankAnalysis({
      businessName,
      keyword,
      placeRank,
      placeRankLabel: localAnalysis.placeRankLabel,
      placeFoundByName: localAnalysis.placeFoundByName,
      blogRank,
      blogRankLabel: blogAnalysisResults.blogRankLabel,
      blogScore,
      blogFoundByName: blogAnalysisResults.blogFoundByName,
      localResults,
      blogResults
    });
    const badges = [
      ...(blogAnalysis.score >= 80 ? ["상위 블로그 문맥 우수"] : []),
      ...(placeRank
        ? ["플레이스 키워드 5위권 노출"]
        : localAnalysis.placeFoundByName
          ? ["업체명 검색 확인", "키워드 5위권 밖"]
          : ["플레이스 미노출"]),
      ...(blogRank
        ? [
            blogAnalysisResults.blogRankSource === "naver-popular-block"
              ? "네이버 인기글 실제 화면 노출 확인"
              : blogAnalysisResults.blogRankSource === "naver-blog-tab"
                ? "네이버 블로그탭 실제 화면 노출 확인"
                : "공식 API 블로그 노출 확인"
          ]
        : blogAnalysisResults.blogFoundByName
          ? ["업체명 블로그 검색 확인", "대표키워드 미노출"]
          : ["블로그 미노출"]),
      ...(blogAnalysis.checks.topTitleKeyword ? ["1위권 제목 키워드 확인"] : []),
      ...(blogAnalysis.checks.richTopBlogContext ? ["상위 블로그 5개 분석"] : []),
      ...(OPENAI_ENABLED ? ["AI 원고 작성 연결"] : ["AI 원고 작성 미설정"])
    ];
    const recommendedKeywords = buildRecommendedKeywords({
      businessName,
      keyword,
      category,
      blogResults,
      localResults
    });
    const prompt = createPrompt({
      businessName,
      keyword,
      category,
      blogScore,
      placeRank,
      blogRank,
      blogRankLabel: blogAnalysisResults.blogRankLabel,
      placeRankLabel: localAnalysis.placeRankLabel,
      recommendedKeywords
    });
    const includeDraft = String(req.body.includeDraft || req.query.includeDraft || "false").toLowerCase() === "true";
    let draft = includeDraft
      ? ""
      : "분석 결과가 먼저 표시되었습니다.\n\nAI 블로그 원고는 별도 요청으로 생성됩니다. 잠시만 기다리면 이 칸에 네이버 블로그 발행용 원고가 자동으로 들어옵니다.";
    let draftSource = includeDraft ? "" : "pending";
    let openAIStatus = includeDraft ? (OPENAI_ENABLED ? "ready" : "missing-key") : "pending";
    let openAIError = "";

    if (includeDraft && !OPENAI_ENABLED && AI_DRAFT_REQUIRED && !AI_FAIL_OPEN) {
      const error = new Error(
        "AI 블로그 작성 서버가 연결되지 않았습니다. Render 환경변수에 OPENAI_CHAT_COMPLETIONS_URL=https://winter-resonance-93f1.qkdlgudrb.workers.dev 와 OPENAI_API_STYLE=chat 을 넣어주세요."
      );
      error.status = 503;
      throw error;
    }

    if (includeDraft) {
      try {
        if (OPENAI_ENABLED) {
          draft = await createOpenAIBlogDraft({
            businessName,
            keyword,
            category,
            blogResults,
            localResults,
            blogScore,
            placeRankLabel: localAnalysis.placeRankLabel,
            blogRank,
            normalizedInput,
            recommendedKeywords,
            writingPrompt: prompt
          });
          draftSource = "openai";
          openAIStatus = "connected";
        }
      } catch (error) {
        console.error("AI draft generation failed:", error.message);
        openAIStatus = "failed";
        openAIError = error.message;
        if (AI_DRAFT_REQUIRED && !AI_FAIL_OPEN) {
          error.status = error.status || 502;
          error.message = `AI 블로그 원고 작성에 실패했습니다. Render의 OPENAI_CHAT_COMPLETIONS_URL, OPENAI_API_STYLE, OPENAI_MODEL 설정을 확인해주세요. 원인: ${error.message}`;
          throw error;
        }
      }

      if (!draft) {
        draft = createBlogDraft({
          businessName,
          keyword,
          category,
          blogResults,
          localResults,
          blogScore,
          placeRankLabel: localAnalysis.placeRankLabel,
          blogRank,
          recommendedKeywords
        });
        draftSource = "built-in";
      }
    }

    if (draftSource !== "pending") {
      draft = cleanBlogDraftForPublishing(draft);
    }

    res.json({
      totalScore,
      placeRank,
      placeRankLabel: localAnalysis.placeRankLabel,
      placeFoundByName: localAnalysis.placeFoundByName,
      blogRank,
      blogRankLabel: blogAnalysisResults.blogRankLabel,
      blogRankSearchQuery: blogAnalysisResults.blogRankSearchQuery,
      blogRankBasis: blogAnalysisResults.blogRankBasis,
      blogRankSource: blogAnalysisResults.blogRankSource || "openapi",
      ownBlogResult: blogAnalysisResults.ownBlogResult,
      ownBlogResults: blogAnalysisResults.ownBlogResults,
      blogVariantRank: blogAnalysisResults.blogVariantRank,
      blogVariantRankLabel: blogAnalysisResults.blogVariantRankLabel,
      blogVariantRankSearchQuery: blogAnalysisResults.blogVariantRankSearchQuery,
      blogFoundByName: blogAnalysisResults.blogFoundByName,
      naverViewUrl: createNaverSearchUrl(keyword, "view"),
      naverBlogUrl: createNaverSearchUrl(keyword, "blog"),
      visibleBlogCheck: {
        keyword,
        viewUrl: createNaverSearchUrl(keyword, "view"),
        blogUrl: createNaverSearchUrl(keyword, "blog"),
        guide:
          blogAnalysisResults.blogRankSource === "naver-popular-block"
            ? "네이버 통합검색 인기글 블록에서 보이는 순서 그대로 확인한 결과입니다. 아래 링크로 직접 비교할 수 있습니다."
            : blogAnalysisResults.blogRankSource === "naver-blog-tab"
              ? "이 키워드는 통합검색 인기글 블록이 없어 네이버 블로그탭 실제 화면 순서로 확인했습니다."
              : "실제 화면 확인이 일시적으로 막혀 공식 API 순서로 표시했습니다. 아래 링크로 실제 화면을 함께 확인하세요."
      },
      blogScore,
      badges,
      rankAnalysis,
      localResults,
      localSearchQueries: localAnalysis.localSearchQueries,
      localSearchErrors: localAnalysis.localSearchErrors,
      blogResults,
      blogContextResults: blogAnalysisResults.blogContextResults,
      blogSearchQueries: blogAnalysisResults.blogSearchQueries,
      blogKeywordSearchQueries: blogAnalysisResults.blogKeywordSearchQueries,
      blogBusinessSearchQueries: blogAnalysisResults.blogBusinessSearchQueries,
      businessBlogResults: blogAnalysisResults.businessBlogResults,
      blogSearchErrors: blogAnalysisResults.blogSearchErrors,
      keywordBlogResults: blogAnalysisResults.keywordBlogResults,
      actions,
      recommendedKeywords,
      draft,
      draftSource,
      openAIStatus,
      openAIError,
      normalizedInput,
      topBlogAnalysis: {
        title: blogAnalysis.title,
        description: blogAnalysis.description,
        checks: blogAnalysis.checks
      },
      prompt
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/draft", async (req, res, next) => {
  try {
    const normalizedInput = normalizeAnalyzeInput({
      businessName: req.body.businessName,
      keyword: req.body.keyword,
      category: req.body.category
    });
    const { businessName, keyword, category } = normalizedInput;

    if (!businessName || !keyword) {
      return res.status(400).json({
        message: "businessName과 keyword는 필수 입력값입니다."
      });
    }

    const localResults = Array.isArray(req.body.localResults) ? req.body.localResults.slice(0, 8) : [];
    const blogResults = Array.isArray(req.body.blogResults) ? req.body.blogResults.slice(0, 8) : [];
    const blogScore = Number(req.body.blogScore || 0);
    const blogRank = req.body.blogRank || null;
    const placeRankLabel = req.body.placeRankLabel || "";
    const selectedKeywords = compactUnique(
      Array.isArray(req.body.selectedKeywords)
        ? req.body.selectedKeywords
        : [req.body.selectedKeyword]
    ).slice(0, 3);
    const recommendedKeywords =
      req.body.recommendedKeywords ||
      buildRecommendedKeywords({
        businessName,
        keyword,
        category,
        blogResults,
        localResults
      });
    let writingPrompt =
      req.body.prompt ||
      createPrompt({
        businessName,
        keyword,
        category,
        blogScore,
        placeRank: req.body.placeRank || null,
        blogRank,
        blogRankLabel: req.body.blogRankLabel || "",
        placeRankLabel,
        recommendedKeywords
      });
    if (selectedKeywords.length) {
      writingPrompt += [
        "",
        "────────────────────",
        "[사용자 선택값]",
        `선택 핵심 키워드: ${selectedKeywords.join(", ")}`,
        "",
        "추천 제목은 사용하지 않는다.",
        "위 선택 핵심 키워드 최대 3개를 반드시 반영해서 작성한다.",
        "최종 제목은 AI가 새롭게 만든다. 대표키워드를 포함하고, 선택 키워드 중 최소 1개를 자연스럽게 반영한다.",
        "제목은 매번 같은 문장이 아니라 검색자가 클릭하고 싶은 새 주제로 만든다.",
        "선택 키워드는 본문 전체의 중심 키워드로 사용하고, 자연스럽게 반복한다."
      ]
        .filter(Boolean)
        .join("\n");
    }

    let draft = "";
    let draftSource = "";
    let openAIStatus = OPENAI_ENABLED ? "ready" : "missing-key";
    let openAIError = "";

    if (!OPENAI_ENABLED && AI_DRAFT_REQUIRED && !AI_FAIL_OPEN) {
      const error = new Error(
        "AI 블로그 작성 서버가 연결되지 않았습니다. Render 환경변수에 OPENAI_CHAT_COMPLETIONS_URL=https://winter-resonance-93f1.qkdlgudrb.workers.dev 와 OPENAI_API_STYLE=chat 을 넣어주세요."
      );
      error.status = 503;
      throw error;
    }

    try {
      if (OPENAI_ENABLED) {
        draft = await createOpenAIBlogDraft({
          businessName,
          keyword,
          category,
          blogResults,
          localResults,
          blogScore,
          placeRankLabel,
          blogRank,
          normalizedInput,
          recommendedKeywords,
          writingPrompt
        });
        draftSource = "openai";
        openAIStatus = "connected";
      }
    } catch (error) {
      console.error("AI draft generation failed:", error.message);
      openAIStatus = "failed";
      openAIError = error.message;
      if (AI_DRAFT_REQUIRED && !AI_FAIL_OPEN) {
        error.status = error.status || 502;
        error.message = `AI 블로그 원고 작성에 실패했습니다. Render의 OPENAI_CHAT_COMPLETIONS_URL, OPENAI_API_STYLE, OPENAI_MODEL 설정을 확인해주세요. 원인: ${error.message}`;
        throw error;
      }
    }

    if (!draft) {
      draft = createBlogDraft({
        businessName,
        keyword,
        category,
        blogResults,
        localResults,
        blogScore,
        placeRankLabel,
        blogRank,
        recommendedKeywords,
        selectedKeywords
      });
      draftSource = "built-in";
    }

    draft = cleanBlogDraftForPublishing(draft);

    res.json({
      draft,
      draftSource,
      openAIStatus,
      openAIError,
      prompt: writingPrompt
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Vary", "Origin");
  const isRateLimit =
    error.status === 429 ||
    String(error.message || "").toLowerCase().includes("rate limit");
  const status = error.status && error.status < 500 ? error.status : 500;

  res.status(status).json({
    message: isRateLimit
      ? "네이버 검색 API 속도 제한에 걸렸습니다. 1분 정도 기다린 뒤 다시 분석해주세요."
      : error.message || "서버 오류가 발생했습니다.",
    details: error.details || undefined
  });
});

app.listen(PORT, () => {
  console.log(`플레이스박사 AI 서버 실행 중: http://localhost:${PORT}`);
});
