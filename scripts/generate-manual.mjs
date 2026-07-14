import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "packages/manual/guide.json");
const outputPath = resolve(root, "docs/USER_GUIDE.md");
const guide = JSON.parse(await readFile(sourcePath, "utf8"));

const lines = [
  `# ${guide.title}`,
  "",
  `版本：${guide.version}  `,
  `更新日期：${guide.updatedAt}`,
  "",
  guide.summary,
  "",
  "> 本文件由 `packages/manual/guide.json` 自动生成，请勿直接编辑。",
  "",
];

for (const section of guide.sections) {
  lines.push(`## ${section.title}`, "", section.intro, "");
  section.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  if (section.notes.length > 0) {
    lines.push("", "注意事项：", "");
    section.notes.forEach((note) => lines.push(`- ${note}`));
  }
  lines.push("");
}

await mkdir(resolve(root, "docs"), { recursive: true });
await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Generated ${outputPath}`);
