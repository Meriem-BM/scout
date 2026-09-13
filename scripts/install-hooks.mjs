if (process.env.HUSKY !== "0") {
  const { default: husky } = await import("husky");

  husky();
}
