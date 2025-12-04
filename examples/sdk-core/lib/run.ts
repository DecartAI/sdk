import "dotenv/config";

export function run(fn: () => Promise<void>) {
  fn().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
}
