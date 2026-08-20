const {
  locateCachedRefreshToken,
  refreshMinecraftAccessToken,
  MsaRefreshError,
} = require("./msaTokenRefresh");

const nmpCacheDir = String.raw`C:\Users\admin\AppData\Roaming\ReplayFiller\fb2104df-e982-4ec2-aaac-9990072f4883\.minecraft\nmp-cache`;

const { refreshToken } = locateCachedRefreshToken(nmpCacheDir);

refreshMinecraftAccessToken(refreshToken)
  .then((r) => {
    console.log("SUCCESS");
    console.log("Profile name:", r.profile.name);
    console.log("Profile id:", r.profile.id);
    console.log("MC token expires in:", r.expiresIn, "seconds");
  })
  .catch((e) => {
    console.log(
      "FAILED at stage:",
      e instanceof MsaRefreshError ? e.stage : "unknown",
    );
    console.log("Message:", e.message);
    console.log("Details:", e.details);
  });
