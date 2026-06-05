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

function hasFitnessIntent(keyword, category) {
  const normalized = normalizeText(`${keyword} ${category}`);
  return FITNESS_TERMS.some((term) => normalized.includes(normalizeText(term)));
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
  const businessQueries = keywordVariants.flatMap((query) => [
    `${businessName} ${query}`,
    `${query} ${businessName}`
  ]);

  return compactUnique([
    ...keywordVariants,
    ...businessQueries,
    `${businessName} ${category}`,
    businessName
  ]).slice(0, 40);
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

async function analyzeLocalResults({ businessName, keyword, category, localDisplay }) {
  const queries = buildLocalQueries({ businessName, keyword, category });
  const display = clampInteger(localDisplay, 5, 1, 5);

  const searches = await Promise.all(
    queries.map(async (query) => {
      const searchType = containsNeedle(query, businessName) ? "business" : "keyword";
      const data = await fetchNaverJson(NAVER_LOCAL_URL, {
        query,
        display,
        start: 1,
        sort: "random"
      });

      return {
        query,
        searchType,
        results: mapLocalResults(data.items, { searchQuery: query, searchType })
      };
    })
  );

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
    localSearchQueries: queries
  };
}

function findBlogRank(blogResults, businessName, keyword) {
  const match = blogResults.find((item) => {
    const content = `${item.title} ${item.description} ${item.bloggerName}`;
    return containsNeedle(content, businessName) || containsNeedle(content, keyword);
  });
  return match ? match.rank : null;
}

async function analyzeBlogResults({ businessName, keyword, category, blogDisplay }) {
  const keywordVariants = buildKeywordVariants({ keyword, category }).slice(0, 6);
  const queries = compactUnique([
    `${businessName} ${keyword}`,
    `${businessName} ${keywordVariants[0] || keyword}`,
    ...keywordVariants,
    `${keyword} 후기`,
    `${keyword} 추천`
  ]).slice(0, 8);
  const display = clampInteger(blogDisplay, 10, 1, 20);

  const searches = await Promise.all(
    queries.map(async (query) => {
      const data = await fetchNaverJson(NAVER_BLOG_URL, {
        query,
        display,
        start: 1,
        sort: "sim"
      });

      return mapBlogResults(data.items, { searchQuery: query });
    })
  );

  return {
    blogResults: uniqueBy(searches.flat(), (item) => item.link || item.title).slice(0, 10),
    blogSearchQueries: queries
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

function createPrompt({
  businessName,
  keyword,
  category,
  blogScore,
  placeRank,
  blogRank,
  placeRankLabel
}) {
  return [
    `너는 네이버 플레이스와 블로그 검색 최적화에 강한 ${category || "로컬 비즈니스"} 콘텐츠 전략가다.`,
    "",
    `업체명: ${businessName}`,
    `핵심 키워드: ${keyword}`,
    `업종: ${category || "미입력"}`,
    `현재 플레이스 순위: ${placeRank ? `${placeRank}위` : placeRankLabel || "미노출"}`,
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

function createBlogDraft({
  businessName,
  keyword,
  category,
  blogResults,
  localResults,
  blogScore,
  placeRankLabel,
  blogRank
}) {
  const safeCategory = category || "업종";
  const topBlogTitles = blogResults
    .slice(0, 5)
    .map((item) => item.title)
    .filter(Boolean);
  const competitorNames = localResults
    .slice(0, 5)
    .map((item) => item.title)
    .filter(Boolean)
    .filter((title) => !containsNeedle(title, businessName));
  const titleIdeas = [
    `${keyword} 찾는다면 ${businessName} 방문 전 체크할 점`,
    `${keyword} ${safeCategory} 선택 기준과 ${businessName} 후기`,
    `${businessName}에서 시작하는 ${keyword} 운동 루틴`,
    `${keyword} 초보도 편하게 상담받는 ${businessName}`,
    `${keyword} 가격 시설 위치 비교 전에 볼 ${businessName} 안내`
  ];

  return [
    "[AI 자동 작성 블로그 초안]",
    "",
    "추천 제목",
    ...titleIdeas.map((title, index) => `${index + 1}. ${title}`),
    "",
    `선택 제목: ${titleIdeas[0]}`,
    "",
    "도입",
    `${keyword}를 검색하는 분들은 보통 집이나 직장에서 가까운 위치, 운동하기 편한 시설, 상담 방식, 가격 부담, 실제 리뷰를 함께 비교합니다. 특히 처음 ${safeCategory}을 알아보는 분이라면 기구가 많다는 말보다 내가 꾸준히 다닐 수 있는 분위기인지, 초보도 무리 없이 시작할 수 있는지, PT나 피티 상담을 받을 때 목표에 맞게 안내받을 수 있는지가 더 중요합니다. 이번 글에서는 ${businessName}을 기준으로 ${keyword} 선택 전에 체크하면 좋은 부분을 자연스럽게 정리해보겠습니다.`,
    "",
    "1. 왜 지금 이 키워드로 비교해야 할까",
    `${keyword}는 단순히 가까운 헬스장을 찾는 검색어가 아닙니다. 다이어트, 체형 관리, 근력 운동, 체력 회복, PT 상담처럼 방문 목적이 분명한 사람들이 많이 검색합니다. 그래서 글 안에는 위치, 시설, 가격, 상담, 후기, 추천 이유가 함께 들어가야 검색하는 사람이 원하는 정보를 빠르게 이해할 수 있습니다. ${businessName}을 찾는 분들도 마찬가지로 운동을 오래 쉬었다가 다시 시작하는 경우, 초보라서 기구 사용이 걱정되는 경우, 혼자 운동하다가 루틴이 막혀 상담이 필요한 경우가 많습니다.`,
    "",
    "2. 시설과 동선 체크",
    `${safeCategory}을 고를 때 시설은 첫인상을 크게 좌우합니다. 기구가 깔끔하게 관리되는지, 운동 동선이 복잡하지 않은지, 피크 시간에도 필요한 운동을 이어갈 수 있는지 확인하는 것이 좋습니다. ${businessName}은 처음 방문하는 사람도 상담을 통해 본인에게 필요한 운동 방향을 잡고, 무리 없이 시작할 수 있는 흐름을 만드는 것이 중요합니다. 블로그 본문에서는 시설 사진을 넣는다면 유산소 공간, 웨이트 기구, 스트레칭 공간, 상담 공간 순서로 보여주면 독자가 훨씬 편하게 이해합니다.`,
    "",
    "3. 초보와 PT 상담 문맥",
    `${keyword}를 찾는 초보자는 무엇부터 해야 할지 몰라서 검색하는 경우가 많습니다. 이때 단순히 운동을 열심히 하면 된다는 말보다, 현재 체력과 목표를 확인하고 다이어트, 근력 증가, 자세 교정, 체형 관리 중 어디에 집중할지 상담받는 과정이 필요하다고 설명하는 것이 좋습니다. ${businessName}에서 PT나 피티를 고민하는 분이라면 첫 상담에서 운동 경험, 생활 패턴, 원하는 변화, 가능한 방문 시간을 먼저 체크해보는 방식으로 글을 구성하면 신뢰도가 올라갑니다.`,
    "",
    "4. 가격보다 중요한 선택 기준",
    `가격은 누구나 궁금해하지만, ${safeCategory} 선택에서 가격만 보고 결정하면 오래 다니기 어렵습니다. 위치가 편한지, 시설 관리가 잘 되는지, 상담이 부담스럽지 않은지, 실제 리뷰에서 꾸준히 다니기 좋다는 이야기가 있는지 함께 비교해야 합니다. ${businessName}을 소개할 때도 무조건 저렴하다는 표현보다 내 목표에 맞는 프로그램을 상담하고, 필요한 기간과 운동 빈도를 확인한 뒤 결정할 수 있다는 식으로 쓰는 편이 자연스럽습니다.`,
    "",
    "5. 방문 전 체크리스트",
    `방문 전에는 네이버 지도에서 ${businessName} 위치를 확인하고, 스마트플레이스에 등록된 운영시간과 리뷰를 살펴보는 것이 좋습니다. 상담을 받을 계획이라면 원하는 시간대에 방문이 가능한지, 초보 운동 상담이 가능한지, 다이어트나 PT 프로그램을 어떻게 시작하는지 미리 확인하면 훨씬 편합니다. ${keyword}를 검색해서 여러 곳을 비교 중이라면 시설, 위치, 리뷰, 상담 방식, 운동 목적과의 적합도를 체크해보세요.`,
    "",
    "6. 자연스러운 마무리",
    `${keyword}를 찾는 분들에게 가장 중요한 것은 단기간에 무리하는 것이 아니라 계속 다닐 수 있는 환경을 고르는 것입니다. ${businessName}은 운동을 처음 시작하는 분, 다시 루틴을 잡고 싶은 분, 다이어트와 체형 관리를 목표로 하는 분들이 방문 전 상담을 통해 방향을 정리해볼 수 있는 곳입니다. 네이버 지도나 스마트플레이스에서 위치와 리뷰, 운영시간을 확인한 뒤 본인에게 맞는 시간에 상담을 받아보면 더 편하게 시작할 수 있습니다.`,
    "",
    "상위 블로그 참고 포인트",
    topBlogTitles.length ? topBlogTitles.map((title) => `- ${title}`).join("\n") : "- 상위 블로그 제목 정보가 부족합니다.",
    "",
    "경쟁 플레이스 참고",
    competitorNames.length ? competitorNames.map((title) => `- ${title}`).join("\n") : "- 경쟁 플레이스 정보가 부족합니다.",
    "",
    "현재 분석 상태",
    `- 플레이스: ${placeRankLabel || "미노출"}`,
    `- 블로그: ${blogRank ? `${blogRank}위` : "미노출"}`,
    `- 기존 본문 점수: ${blogScore}점`,
    "",
    "사용 팁",
    "- 실제 사진 5장 이상을 넣어주세요.",
    "- 첫 문단 350자 안에 업체명, 키워드, 지역, 업종, 방문 이유가 들어가게 유지하세요.",
    "- 가격, 시설, 위치, 리뷰, 상담, PT, 피티, 초보, 다이어트, 운동 문맥을 과하지 않게 분산하세요.",
    "- 마지막 문단에는 네이버 지도 또는 스마트플레이스 확인 문장을 넣으세요."
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
    const blogRank = findBlogRank(blogResults, businessName, keyword);
    const blogAnalysis = calculateBlogScore({ blogText, keyword, category });
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
    const badges = [
      ...(blogAnalysis.score >= 80 ? ["블로그 품질 우수"] : []),
      ...(placeRank
        ? ["플레이스 키워드 5위권 노출"]
        : localAnalysis.placeFoundByName
          ? ["업체명 검색 확인", "키워드 5위권 밖"]
          : ["플레이스 미노출"]),
      ...(blogRank ? ["블로그 검색 노출 확인"] : ["블로그 미노출"]),
      ...(blogAnalysis.checks.first350Keyword ? ["초반 키워드 배치"] : []),
      ...(blogAnalysis.checks.enoughLength ? ["충분한 본문 길이"] : [])
    ];

    res.json({
      totalScore,
      placeRank,
      placeRankLabel: localAnalysis.placeRankLabel,
      placeFoundByName: localAnalysis.placeFoundByName,
      blogRank,
      blogScore,
      badges,
      localResults,
      localSearchQueries: localAnalysis.localSearchQueries,
      blogResults,
      blogSearchQueries: blogAnalysisResults.blogSearchQueries,
      actions,
      draft: createBlogDraft({
        businessName,
        keyword,
        category,
        blogResults,
        localResults,
        blogScore,
        placeRankLabel: localAnalysis.placeRankLabel,
        blogRank
      }),
      prompt: createPrompt({
        businessName,
        keyword,
        category,
        blogScore,
        placeRank,
        blogRank,
        placeRankLabel: localAnalysis.placeRankLabel
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
