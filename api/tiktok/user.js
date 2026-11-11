'use strict';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MISS_CACHE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 7000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_CACHE_ENTRIES = 200;
const NOT_FOUND_PROFILE_CODES = new Set([10202, 10221, 10222, 10223, 10224]);
const responseCache = new Map();

function sendJson(res, statusCode, payload, cacheControl = 'no-store') {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify(payload));
}

function normalizeUsername(value) {
    if (typeof value !== 'string') return null;
    const username = value.trim().replace(/^@/, '').trim();
    return /^[A-Za-z0-9._]{1,24}$/.test(username) ? username : null;
}

function getCached(username) {
    const key = username.toLowerCase();
    const entry = responseCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        responseCache.delete(key);
        return null;
    }
    responseCache.delete(key);
    responseCache.set(key, entry);
    return entry.value;
}

function setCached(username, value, ttlMs) {
    const key = username.toLowerCase();
    responseCache.delete(key);
    responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (responseCache.size > MAX_CACHE_ENTRIES) {
        responseCache.delete(responseCache.keys().next().value);
    }
}

async function readLimitedText(response, maxBytes = MAX_BODY_BYTES) {
    if (!response.body) return '';

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body.cancel();
        throw new Error('TikTok response was too large');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error('TikTok response was too large');
        }
        text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
}

async function readLimitedBuffer(response, maxBytes = 4_000_000) {
    if (!response.body) return Buffer.alloc(0);

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body.cancel();
        throw new Error('TikTok avatar was too large');
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error('TikTok avatar was too large');
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
}

function isTikTokHost(url) {
    return url.protocol === 'https:' &&
        (url.hostname === 'www.tiktok.com' || url.hostname === 'tiktok.com') &&
        !url.port &&
        !url.username && !url.password;
}

function isTikTokCdnUrl(url) {
    return url.protocol === 'https:' &&
        !url.port &&
        !url.username &&
        !url.password &&
        /(?:^|\.)tiktokcdn(?:-[a-z0-9-]+)?\.com$/i.test(url.hostname);
}

async function fetchTikTokAvatar(avatarUrl, deadline) {
    let currentUrl;
    try {
        currentUrl = new URL(avatarUrl);
    } catch {
        return { kind: 'unavailable' };
    }

    for (let redirectCount = 0; redirectCount <= 2; redirectCount += 1) {
        if (!isTikTokCdnUrl(currentUrl)) return { kind: 'unavailable' };

        const remainingMs = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
        if (remainingMs <= 0) return { kind: 'connection_error' };

        try {
            const response = await fetch(currentUrl, {
                method: 'GET',
                headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
                redirect: 'manual',
                signal: AbortSignal.timeout(remainingMs)
            });

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                await response.body?.cancel();
                if (!location || redirectCount === 2) return { kind: 'unavailable' };
                currentUrl = new URL(location, currentUrl);
                if (!isTikTokCdnUrl(currentUrl)) return { kind: 'unavailable' };
                continue;
            }

            if (response.status === 429) {
                const retryAfter = Number(response.headers.get('retry-after'));
                await response.body?.cancel();
                return { kind: 'rate_limited', retryAfter };
            }
            if (response.status === 403 || response.status === 404) {
                await response.body?.cancel();
                return { kind: 'expired' };
            }
            if (!response.ok) {
                await response.body?.cancel();
                return { kind: response.status >= 500 ? 'connection_error' : 'unavailable' };
            }

            const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (!/^image\/(jpeg|jpg|png|webp|gif|avif)$/.test(contentType)) {
                await response.body?.cancel();
                return { kind: 'unavailable' };
            }

            return {
                kind: 'found',
                contentType,
                bytes: await readLimitedBuffer(response)
            };
        } catch {
            return { kind: 'connection_error' };
        }
    }

    return { kind: 'unavailable' };
}

async function fetchTikTok(url, accept, deadline) {
    let currentUrl = new URL(url);

    for (let redirectCount = 0; redirectCount <= 2; redirectCount += 1) {
        if (!isTikTokHost(currentUrl)) return { blockedRedirect: true };

        const remainingMs = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
        if (remainingMs <= 0) throw new Error('TikTok request timed out');
        const response = await fetch(currentUrl, {
            method: 'GET',
            headers: { Accept: accept },
            redirect: 'manual',
            signal: AbortSignal.timeout(remainingMs)
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location || redirectCount === 2) {
                await response.body?.cancel();
                return { response, blockedRedirect: false };
            }
            const nextUrl = new URL(location, currentUrl);
            await response.body?.cancel();
            if (!isTikTokHost(nextUrl)) return { blockedRedirect: true };
            currentUrl = nextUrl;
            continue;
        }

        return { response, blockedRedirect: false };
    }

    return { blockedRedirect: true };
}

function profileUrlFor(username) {
    return `https://www.tiktok.com/@${encodeURIComponent(username)}`;
}

function safeDisplayName(value) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 100);
}

function safeAvatarUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return isTikTokCdnUrl(url) ? url.href : null;
    } catch {
        return null;
    }
}

function safeCount(...values) {
    for (const value of values) {
        const raw = typeof value === 'number' && Number.isFinite(value)
            ? String(value)
            : typeof value === 'string' ? value.trim() : '';
        if (!/^\d{1,16}$/.test(raw)) continue;
        const count = Number(raw);
        if (Number.isSafeInteger(count)) return count;
    }
    return null;
}

function makeUser(username, displayName, avatarUrl, stats = {}) {
    return {
        username,
        displayName: safeDisplayName(displayName),
        avatarUrl: safeAvatarUrl(avatarUrl),
        followingCount: safeCount(stats.followingCount),
        followerCount: safeCount(stats.followerCount),
        likeCount: safeCount(stats.likeCount)
    };
}

function readPublicProfilePage(html, expectedUsername) {
    const stateMatch = html.match(/<script\b[^>]*id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!stateMatch) return { kind: 'unknown' };

    let state;
    try {
        state = JSON.parse(stateMatch[1]);
    } catch {
        return { kind: 'unknown' };
    }

    const details = state?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
    if (!details) return { kind: 'unknown' };

    const statusCode = Number(details.statusCode);
    if (NOT_FOUND_PROFILE_CODES.has(statusCode)) return { kind: 'not_found' };
    if (statusCode !== 0) return { kind: 'unknown' };

    const userInfo = details.userInfo;
    const user = userInfo?.user;
    if (!user || typeof user.uniqueId !== 'string' ||
        user.uniqueId.toLowerCase() !== expectedUsername.toLowerCase()) {
        return { kind: 'unknown' };
    }

    if (user.privateAccount === true || user.isPrivateAccount === true) {
        return { kind: 'private' };
    }

    return {
        kind: 'found',
        user: makeUser(
            user.uniqueId,
            user.nickname,
            user.avatarLarger || user.avatarMedium || user.avatarThumb,
            {
                followingCount: safeCount(userInfo.statsV2?.followingCount, userInfo.stats?.followingCount),
                followerCount: safeCount(userInfo.statsV2?.followerCount, userInfo.stats?.followerCount),
                likeCount: safeCount(
                    userInfo.statsV2?.heartCount,
                    userInfo.statsV2?.heart,
                    userInfo.stats?.heartCount,
                    userInfo.stats?.heart
                )
            }
        )
    };
}

function cacheHeaders(ttlSeconds) {
    return `public, max-age=0, s-maxage=${ttlSeconds}, stale-while-revalidate=600`;
}

function finish(res, username, statusCode, payload, ttlMs = 0) {
    if (ttlMs > 0) setCached(username, { statusCode, payload, ttlMs }, ttlMs);
    return sendJson(res, statusCode, payload, ttlMs > 0 ? cacheHeaders(Math.floor(ttlMs / 1000)) : 'no-store');
}

async function readProfileMetadata(username, deadline) {
    const profileUrl = profileUrlFor(username);
    const result = await fetchTikTok(profileUrl, 'text/html,application/xhtml+xml', deadline);
    if (result.blockedRedirect) return { kind: 'unable_to_verify' };
    if (result.response.status === 429) {
        const retryAfter = Number(result.response.headers.get('retry-after'));
        await result.response.body?.cancel();
        return { kind: 'rate_limited', retryAfter };
    }
    if ([401, 403, 451].includes(result.response.status)) {
        await result.response.body?.cancel();
        return { kind: 'unable_to_verify' };
    }
    if (result.response.status === 404) {
        await result.response.body?.cancel();
        return { kind: 'not_found' };
    }
    if (!result.response.ok) {
        await result.response.body?.cancel();
        return { kind: result.response.status >= 500 ? 'connection_error' : 'unable_to_verify' };
    }

    const html = await readLimitedText(result.response);
    return readPublicProfilePage(html, username);
}

async function handleAvatarRequest(username, res) {
    const deadline = Date.now() + 9000;
    const cached = getCached(username);
    let user = cached?.statusCode === 200 ? cached.payload.user : null;

    if (!user?.avatarUrl) {
        let metadata;
        try {
            metadata = await readProfileMetadata(username, deadline);
        } catch {
            metadata = { kind: 'connection_error' };
        }

        if (metadata.kind === 'rate_limited') {
            const retryAfter = metadata.retryAfter;
            res.setHeader('Retry-After', Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 3600 ? String(Math.ceil(retryAfter)) : '30');
            return sendJson(res, 429, { error: 'rate_limited' });
        }
        if (metadata.kind === 'not_found') return sendJson(res, 404, { error: 'user_not_found' });
        if (metadata.kind === 'connection_error') return sendJson(res, 502, { error: 'tiktok_unavailable' });
        if (metadata.kind !== 'found') return sendJson(res, 422, { error: 'avatar_unavailable' });
        user = metadata.user;
    }

    if (!user.avatarUrl) return sendJson(res, 404, { error: 'avatar_unavailable' });

    let image = await fetchTikTokAvatar(user.avatarUrl, deadline);
    if (image.kind === 'expired') {
        try {
            const metadata = await readProfileMetadata(username, deadline);
            if (metadata.kind === 'found' && metadata.user.avatarUrl) {
                image = await fetchTikTokAvatar(metadata.user.avatarUrl, deadline);
            }
        } catch {
            // Keep the expired result and report that the avatar could not be retrieved.
        }
    }

    if (image.kind === 'rate_limited') {
        const retryAfter = image.retryAfter;
        res.setHeader('Retry-After', Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 3600 ? String(Math.ceil(retryAfter)) : '30');
        return sendJson(res, 429, { error: 'rate_limited' });
    }
    if (image.kind !== 'found') {
        return sendJson(res, image.kind === 'connection_error' ? 502 : 404, { error: 'avatar_unavailable' });
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', String(image.bytes.length));
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(image.bytes);
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    const rawUsername = Array.isArray(req.query?.username) ? null : req.query?.username;
    const username = normalizeUsername(rawUsername);
    if (!username) return sendJson(res, 400, { error: 'invalid_username' });
    if (req.query?.avatar === '1') return handleAvatarRequest(username, res);

    const cached = getCached(username);
    if (cached) {
        return sendJson(res, cached.statusCode, cached.payload, cacheHeaders(Math.floor(cached.ttlMs / 1000)));
    }

    const deadline = Date.now() + 9000;
    let metadata;
    try {
        metadata = await readProfileMetadata(username, deadline);
    } catch {
        metadata = { kind: 'connection_error' };
    }

    if (metadata.kind === 'private') {
        return finish(res, username, 422, { error: 'private_profile' }, MISS_CACHE_TTL_MS);
    }

    if (metadata.kind === 'not_found') {
        return finish(res, username, 404, { error: 'user_not_found' }, MISS_CACHE_TTL_MS);
    }
    if (metadata.kind === 'rate_limited') {
        const retryAfter = metadata.retryAfter;
        res.setHeader('Retry-After', Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 3600 ? String(Math.ceil(retryAfter)) : '30');
        return sendJson(res, 429, { error: 'rate_limited' });
    }
    if (metadata.kind === 'connection_error') {
        return sendJson(res, 502, { error: 'tiktok_unavailable' });
    }
    if (metadata.kind === 'found') {
        if (!metadata.user.avatarUrl) {
            return finish(res, username, 422, { error: 'avatar_unavailable' }, MISS_CACHE_TTL_MS);
        }
        return finish(res, username, 200, { ok: true, user: metadata.user }, CACHE_TTL_MS);
    }
    if (metadata.kind === 'unable_to_verify' || metadata.kind === 'unknown') {
        return sendJson(res, 422, { error: 'unable_to_verify' });
    }

    return sendJson(res, 422, { error: 'unable_to_verify' });
};
