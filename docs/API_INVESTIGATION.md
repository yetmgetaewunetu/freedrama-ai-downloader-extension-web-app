# FreeDrama.ai API Investigation Notes

Findings recorded from Chrome DevTools network inspection on FreeDrama.ai (`love-is-a-dangerous-game-2-45153c99`, Episode 1 and Episode 43).

## 1. Platform Architecture
- Frontend framework: SolidStart / SolidJS SSR (`<html data-ssr="1">`).
- Public show URL format: `https://freedrama.ai/{locale}/show/{slug}`
- Public episode URL format: `https://freedrama.ai/{locale}/show/{slug}/{ordinal}[?ref={token}]`
- The trailing 8-character hex segment of a public slug (e.g., `45153c99` in `love-is-a-dangerous-game-2-45153c99`) corresponds to the first 8 hex characters of the internal `seriesId` UUID (`45153c99-4457-4133-8305-29235cfa649d`).

## 2. Discovered API Endpoints

### 2.1 Series & Episode List Endpoint
| Property | Observed Detail |
|---|---|
| Request URL | `https://freedrama.ai/api/series/{slugOrUuid}` |
| HTTP Method | `GET` |
| Query Parameters | None |
| Request Payload | None |
| Content-Type | N/A |
| Accept | `*/*` or `application/json` |
| Authentication | Not required for series metadata & episode listing |
| Cookies | Not required |
| Response Status | `200 OK` (or `404 Not Found` with `{"error":"not_found"}`) |
| Response Content-Type | `application/json` |

Behavior verified:
- Accepts public slug (`love-is-a-dangerous-game-2-45153c99`), canonical slug (`love-is-a-dangerous-game-2`), or full `seriesId` UUID.
- Returns the entire episode list in `episodes` in a single unpaginated array ordered ascending by `ordinal` (`1..N`).
- Each episode item includes `id` (episode UUID), `ordinal`, `title`, `durationS`, `lock` (`"free"`, `"vip"`, or `"none"`), `still`, `publishedAt`.

### 2.2 Direct Episode Playback Endpoint
| Property | Observed Detail |
|---|---|
| Request URL | `https://freedrama.ai/api/episode/{episodeId}/playback` |
| HTTP Method | `GET` |
| Query Parameters | None |
| Request Payload | None |
| Content-Type | N/A |
| Accept | `*/*` or `application/json` |
| Optional Headers | `x-app-locale: en-US`, `x-app-link-locale: en-US` |
| Authentication | Not required for `lock: "free"` episodes; required via session cookie for entitled/VIP episodes |
| Cookies | HttpOnly session cookies (e.g., `drama_visitor`, `drama_device`, etc.) when accessing VIP episodes |
| Response Status | `200 OK` when entitled/free; `403 Forbidden` (`{"error":"not_entitled",...}`) when locked |
| Response Content-Type | `application/json` |

Response fields observed:
- `episodeId`, `seriesId`, `ordinal`, `durationS`, `source` (`"free"` or `"vip"`)
- `renditions`: array of objects with `height` (`960`, `1920`), `width` (`540`, `1080`), `bandwidth`, `averageBandwidth`, `codecs`, `url`, `mp4Url`, `expiresAt` (Unix seconds, ~5-6 minute TTL)
- `subtitleMode`, `subtitles`, `languages`, `audio`, `pickedAudio`, `pickedLanguage`, `originalLanguage`, `burnedIn`, `cleanCutAvailable`, `resumeAt`, `shareUrl`, `openUrl`

### 2.3 Initial Page Bootstrap Endpoint
- `GET https://freedrama.ai/api/web/session?series={slug}&ep={ordinal}[&ref={token}]`
- Returns `opening.detail` (series + episodes) and `opening.playback` when the episode is free or the session cookie is entitled. Omits `opening` for unauthenticated requests to locked episodes.

## 3. CDN Video Delivery (`cdn.freedrama.ai`)
- Signed URL format: `https://cdn.freedrama.ai/bcdn_token={TOKEN}&expires={UNIX_TS}&token_path={ENCODED_PATH}/media/series/{seriesId}/episodes/{ep4}/video/{lang}/{height}/video.mp4`
- Signed CDN URLs work via server-side `GET` without cookies or `Referer` until `expires`.
- Observed video responses:
  - `GET` with `Range: bytes=0-` returns `206 Partial Content`, `Content-Type: video/mp4`, `Content-Length`, `Content-Range: bytes 0-{end}/{total}`.
  - `HEAD` without `Range` returns `200 OK` with `Content-Length` and `Content-Type: video/mp4`.
  - `Accept-Ranges` header was not present in the observed `206` responses.
  - Standard full-file `GET` (no `Range` header) should be used first, falling back to verified `Content-Range` checks only if resuming.
