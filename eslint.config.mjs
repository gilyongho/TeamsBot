export default [{
  files: ["*.js"],
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "commonjs",
    globals: { require:"readonly", module:"writable", process:"readonly", console:"readonly",
               __dirname:"readonly", Buffer:"readonly", setTimeout:"readonly",
               setInterval:"readonly", clearTimeout:"readonly", clearInterval:"readonly",
               URL:"readonly", URLSearchParams:"readonly", crypto:"readonly" }
  },
  rules: {
    "no-undef": "error",
    "no-unreachable": "error",
    "no-unused-vars": ["warn", {"args":"none","varsIgnorePattern":"^(TEAMSAPP|UIPATH|MSGQUEUE|PROCQUEUE|JOBTABLE)$"}],
    "no-dupe-keys": "error",
    "require-atomic-updates": "warn",
    "no-fallthrough": "error"
  }
}];
