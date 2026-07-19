import argon2 from "argon2";

const hash = await argon2.hash("chimera-argon2-runtime-smoke", {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
});

if (!hash.startsWith("$argon2id$v=19$m=65536,t=3,p=1$") || !await argon2.verify(hash, "chimera-argon2-runtime-smoke")) {
    throw new Error("Argon2 runtime smoke check failed");
}
