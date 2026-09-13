const config = {
  "*.{cjs,js,jsx,mjs,ts,tsx}": [
    "eslint --fix --max-warnings=0 --no-warn-ignored",
    "prettier --write",
  ],
  "*.{css,html,json,jsonc,md,mdx,scss,yaml,yml}": "prettier --write",
};

export default config;
