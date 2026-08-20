// msaTokenRefresh.js - manually refreshes a cached Microsoft OAuth refresh
// token into a fresh Minecraft Java access token
// Copyright (C) 2026  sw-rm
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// -- Imports --------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const { Titles } = require("prismarine-auth");

// -- Constants --------------------------------------------------------------
const MSA_REFRESH_URL = "https://login.live.com/oauth20_token.srf";
const XBL_AUTH_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_AUTH_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL =
  "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";

// A "flow" bundles the three things that must all agree with each other:
// which app (client_id) the refresh token was issued to, what scope it was
// issued for, and which RpsTicket prefix Xbox Live expects for tokens minted
// under that client_id/scope combo. Mixing pieces from different flows is a
// silent 401 at the Xbox Live hop.
const REPLAYFILLER_FLOW = {
  clientId: Titles.MinecraftNintendoSwitch,
  scope: "service::user.auth.xboxlive.com::MBI_SSL",
  rpsPrefix: "t=",
};

const IAS_FLOW = {
  // ru.vidtu.ias.IAS.CLIENT_ID - In-Game Account Switcher's own Azure app.
  clientId: "54fd49e4-2103-4044-9603-2b028c814ec3",
  scope: "XboxLive.signin XboxLive.offline_access",
  rpsPrefix: "d=",
};

const MEOWTILS_FLOW = {
  // meowtils.accountmanagerext.auth.MicrosoftAuth.CLIENT_ID - Meowtils'
  // Account Manager extension's own Azure app.
  clientId: "42a60a84-599d-44b2-a7c6-b00cdef1d6a2",
  scope: "XboxLive.signin XboxLive.offline_access",
  rpsPrefix: "d=",
};

// Chain (each function below is one hop):
//   1. refreshMicrosoftToken    - POST login.live.com                      (refresh MSA token)
//   2. authenticateWithXboxLive - POST user.auth.xboxlive.com/authenticate (Xbox Live user token)
//   3. authorizeWithXsts        - POST xsts.auth.xboxlive.com/authorize    (XSTS token)
//   4. loginWithXbox            - POST api.minecraftservices.com/.../login_with_xbox
//   5. fetchMinecraftProfile    - GET  api.minecraftservices.com/minecraft/profile (optional)

// -- Errors -------------------------------------------------------------------
class MsaRefreshError extends Error {
  constructor(stage, message, details) {
    super(`[${stage}] ${message}`);
    this.name = "MsaRefreshError";
    this.stage = stage;
    this.details = details;
  }
}

// -- HTTP helpers ---------------------------------------------------------------
async function safeJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  const parsed = await safeJson(res);
  if (!res.ok) {
    throw new MsaRefreshError(
      "msa-refresh",
      `${url} returned ${res.status}`,
      parsed,
    );
  }
  return parsed;
}

async function postJson(url, body, stage) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await safeJson(res);
  if (!res.ok) {
    throw new MsaRefreshError(stage, `${url} returned ${res.status}`, parsed);
  }
  return parsed;
}

// -- Chain steps ------------------------------------------------------------------
// Step 1: exchange a cached MSA refresh_token for a fresh access_token
// (and usually a rotated refresh_token - callers should persist the new one).
async function refreshMicrosoftToken(refreshToken, flow = REPLAYFILLER_FLOW) {
  const data = await postForm(MSA_REFRESH_URL, {
    grant_type: "refresh_token",
    client_id: flow.clientId,
    refresh_token: refreshToken,
    scope: flow.scope,
  });
  if (!data?.access_token) {
    throw new MsaRefreshError(
      "msa-refresh",
      "No access_token in response",
      data,
    );
  }
  return data; // { access_token, refresh_token, expires_in, ... }
}

// Step 2: trade the MSA access_token for an Xbox Live user token.
//
// IMPORTANT: the RpsTicket prefix must match the flow the access_token came
// from (see REPLAYFILLER_FLOW/IAS_FLOW above). Using the wrong one is a
// silent 401 here.
async function authenticateWithXboxLive(msaAccessToken, rpsPrefix = "t=") {
  const data = await postJson(
    XBL_AUTH_URL,
    {
      Properties: {
        AuthMethod: "RPS",
        SiteName: "user.auth.xboxlive.com",
        RpsTicket: `${rpsPrefix}${msaAccessToken}`,
      },
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
    },
    "xbl-auth",
  );
  const userHash = data?.DisplayClaims?.xui?.[0]?.uhs;
  if (!data?.Token || !userHash) {
    throw new MsaRefreshError("xbl-auth", "Malformed Xbox Live response", data);
  }
  return { token: data.Token, userHash };
}

// Step 3: upgrade the Xbox Live user token to an XSTS token scoped for Minecraft.
async function authorizeWithXsts(xblToken) {
  try {
    const data = await postJson(
      XSTS_AUTH_URL,
      {
        Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
        RelyingParty: "rp://api.minecraftservices.com/",
        TokenType: "JWT",
      },
      "xsts-auth",
    );
    const userHash = data?.DisplayClaims?.xui?.[0]?.uhs;
    if (!data?.Token || !userHash) {
      throw new MsaRefreshError("xsts-auth", "Malformed XSTS response", data);
    }
    return { token: data.Token, userHash };
  } catch (err) {
    if (err instanceof MsaRefreshError && err.details?.XErr) {
      throw new MsaRefreshError(
        "xsts-auth",
        describeXstsError(err.details.XErr),
        err.details,
      );
    }
    throw err;
  }
}

function describeXstsError(xErr) {
  const known = {
    2148916233:
      "No Xbox Live profile on this Microsoft account (create one at xbox.com).",
    2148916235: "Xbox Live isn't available in this account's region.",
    2148916236: "Account needs adult verification (South Korea).",
    2148916237: "Account needs adult verification (South Korea).",
    2148916238: "Child account - needs to be added to a Family by an adult.",
  };
  return known[xErr] || `XSTS authorization failed (XErr ${xErr}).`;
}

// Step 4: exchange the XSTS token for a Minecraft Java access_token.
async function loginWithXbox(userHash, xstsToken) {
  const data = await postJson(
    MC_LOGIN_URL,
    { identityToken: `XBL3.0 x=${userHash};${xstsToken}` },
    "mc-login",
  );
  if (!data?.access_token) {
    throw new MsaRefreshError("mc-login", "No access_token in response", data);
  }
  return data; // { username (undashed uuid), roles, access_token, expires_in }
}

// Step 5 (optional): confirm the token works and fetch name + dashed uuid.
async function fetchMinecraftProfile(mcAccessToken) {
  const res = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${mcAccessToken}` },
  });
  const parsed = await safeJson(res);
  if (!res.ok) {
    throw new MsaRefreshError(
      "mc-profile",
      `Profile lookup returned ${res.status}`,
      parsed,
    );
  }
  return parsed; // { id, name, ... }
}

// Full chain: refresh_token -> Minecraft access_token (+ profile).
async function refreshMinecraftAccessToken(
  refreshToken,
  { flow = REPLAYFILLER_FLOW, fetchProfile = true } = {},
) {
  const msa = await refreshMicrosoftToken(refreshToken, flow);
  const xbl = await authenticateWithXboxLive(msa.access_token, flow.rpsPrefix);
  const xsts = await authorizeWithXsts(xbl.token);
  const mc = await loginWithXbox(xsts.userHash, xsts.token);

  const result = {
    accessToken: mc.access_token,
    expiresIn: mc.expires_in,
    obtainedOn: Date.now(),
    // MS commonly rotates the refresh token on every use - the old one may
    // stop working, so always persist whichever one comes back.
    msaRefreshToken: msa.refresh_token || refreshToken,
    msaAccessTokenExpiresIn: msa.expires_in,
  };

  if (fetchProfile) {
    result.profile = await fetchMinecraftProfile(mc.access_token);
  }
  return result;
}

// -- Cache file helpers ---------------------------------------------------------
// Matches BotWorker.js's existing schema assumptions
// (hasCachedMicrosoftRefreshToken checks data?.token?.refresh_token,
// possibly nested one level under a wrapper key - mirrored here).

function findRefreshTokenCacheFiles(tokenDir) {
  if (!fs.existsSync(tokenDir)) return [];
  return fs
    .readdirSync(tokenDir)
    .filter(
      (f) => f.endsWith("_live-cache.json") || f.endsWith("_msal-cache.json"),
    )
    .map((f) => path.join(tokenDir, f));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// Returns { filePath, keyPath, refreshToken } for the first usable refresh
// token found, where keyPath is [] if refresh_token is top-level under
// `token`, or [wrapperKey] if nested one level (matches
// hasCachedMicrosoftRefreshToken's Object.values(...) fallback).
function locateCachedRefreshToken(tokenDir) {
  for (const filePath of findRefreshTokenCacheFiles(tokenDir)) {
    const data = readJson(filePath);
    if (!data) continue;

    if (data?.token?.refresh_token) {
      return { filePath, keyPath: [], refreshToken: data.token.refresh_token };
    }
    for (const [key, value] of Object.entries(data)) {
      if (value?.token?.refresh_token) {
        return {
          filePath,
          keyPath: [key],
          refreshToken: value.token.refresh_token,
        };
      }
    }
  }
  return null;
}

function writeRefreshTokenBack(filePath, keyPath, newRefreshToken) {
  const data = readJson(filePath) || {};
  const target = keyPath.length === 0 ? data : data[keyPath[0]];
  if (!target) return;
  target.token = target.token || {};
  target.token.refresh_token = newRefreshToken;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// -- High-level entry points -------------------------------------------------------
// Silently refresh ReplayFiller's own cached Microsoft session for an
// account, returning a mineflayer-ready `session` object (same shape as
// sourceCandidate.session used with mojangAuth), or null if there's no
// usable cached refresh token in tokenDir.
async function refreshReplayFillerSession(tokenDir) {
  const located = locateCachedRefreshToken(tokenDir);
  if (!located) return null;

  const result = await refreshMinecraftAccessToken(located.refreshToken, {
    flow: REPLAYFILLER_FLOW,
  });
  writeRefreshTokenBack(
    located.filePath,
    located.keyPath,
    result.msaRefreshToken,
  );

  return {
    accessToken: result.accessToken,
    selectedProfile: {
      id: result.profile.id,
      name: result.profile.name,
    },
    availableProfiles: [{ id: result.profile.id, name: result.profile.name }],
  };
}

// Silently refresh a source-imported (In-Game Account Switcher) refresh
// token into a fresh Minecraft session, using IAS's own client_id/scope.
// Does not read or write IAS's own account file - callers are responsible
// for supplying refreshToken and persisting the rotated one (see
// index.js/BotWorker.js's ias-refresh-cache.json handling), so this never
// touches files the IAS mod itself owns.
async function refreshIasSession(refreshToken) {
  const result = await refreshMinecraftAccessToken(refreshToken, {
    flow: IAS_FLOW,
  });

  return {
    session: {
      accessToken: result.accessToken,
      selectedProfile: { id: result.profile.id, name: result.profile.name },
      availableProfiles: [{ id: result.profile.id, name: result.profile.name }],
    },
    rotatedRefreshToken: result.msaRefreshToken,
    profile: result.profile,
  };
}

// Silently refresh a source-imported (Meowtils Account Manager) refresh
// token into a fresh Minecraft session, using Meowtils' own client_id/scope.
// Does not read or write Meowtils' own accounts.json - callers are
// responsible for supplying refreshToken and persisting the rotated one
// (see ReplayFill.js's meowtils-refresh-cache.json handling), so this never
// touches files the Meowtils extension itself owns.
async function refreshMeowtilsSession(refreshToken) {
  const result = await refreshMinecraftAccessToken(refreshToken, {
    flow: MEOWTILS_FLOW,
  });

  return {
    session: {
      accessToken: result.accessToken,
      selectedProfile: { id: result.profile.id, name: result.profile.name },
      availableProfiles: [{ id: result.profile.id, name: result.profile.name }],
    },
    rotatedRefreshToken: result.msaRefreshToken,
    profile: result.profile,
  };
}

module.exports = {
  MsaRefreshError,
  REPLAYFILLER_FLOW,
  IAS_FLOW,
  MEOWTILS_FLOW,
  refreshMicrosoftToken,
  authenticateWithXboxLive,
  authorizeWithXsts,
  loginWithXbox,
  fetchMinecraftProfile,
  refreshMinecraftAccessToken,
  locateCachedRefreshToken,
  refreshReplayFillerSession,
  refreshIasSession,
  refreshMeowtilsSession,
};
