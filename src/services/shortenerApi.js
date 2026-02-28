import axios from "axios";

const baseURL = process.env.SHORTNER_BASE_URL || "https://linkshortner.co";

const client = axios.create({
  baseURL,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${process.env.SHORTNER_API_KEY}`,
    "Content-Type": "application/json"
  }
});

function getErrorMessage(error) {
  const body = error?.response?.data;
  return body?.error || body?.message || error?.message || "Request failed";
}

function pickShortUrl(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.shortUrl ||
    payload.shortURL ||
    payload.short_link ||
    payload.url ||
    payload?.link?.shortUrl ||
    payload?.link?.shortURL ||
    payload?.link?.short_link ||
    payload?.link?.url ||
    payload?.data?.shortUrl ||
    payload?.data?.shortURL ||
    payload?.data?.short_link ||
    payload?.data?.url ||
    payload?.data?.link?.shortUrl ||
    payload?.data?.link?.shortURL ||
    payload?.data?.link?.short_link ||
    payload?.data?.link?.url ||
    null
  );
}

function pickData(body) {
  if (!body || typeof body !== "object") return {};
  return body.data || body.link || body;
}

export async function shortenUrl(url, options = {}) {
  try {
    const payload = { url };
    if (options.customAlias) payload.customAlias = options.customAlias;
    if (options.expiresIn) payload.expiresIn = Number(options.expiresIn);
    if (options.domainId) payload.domainId = options.domainId;
    const response = await client.post("/api/v1/shorten", payload);
    const body = response.data || {};
    if (body.success === false) {
      throw new Error(body.message || body.error || "Shorten failed");
    }
    const shortUrl = pickShortUrl(body);
    if (!shortUrl) {
      throw new Error("No short URL in API response");
    }
    return shortUrl;
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function listLinks(params = {}) {
  try {
    const response = await client.get("/api/v1/user/links", { params });
    const body = response.data || {};
    if (body.success === false) throw new Error(body.message || body.error || "List links failed");
    return pickData(body);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function getLink(linkId) {
  try {
    const response = await client.get(`/api/v1/links/${linkId}`);
    const body = response.data || {};
    if (body.success === false) throw new Error(body.message || body.error || "Get link failed");
    return pickData(body);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function getStats(linkId, days = 30, limit = 1000) {
  try {
    const response = await client.get(`/api/v1/stats/${linkId}`, { params: { days, limit } });
    const body = response.data || {};
    if (body.success === false) throw new Error(body.message || body.error || "Stats failed");
    return pickData(body);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function listDomains() {
  try {
    const response = await client.get("/api/v1/domains");
    const body = response.data || {};
    if (body.success === false) throw new Error(body.message || body.error || "Domains failed");
    return pickData(body);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}
