// Conventional Commits drive release-please: feat → minor, fix → patch, feat! / BREAKING CHANGE → major.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [1, "always", 120],
    "footer-max-line-length": [1, "always", 120],
  },
}
