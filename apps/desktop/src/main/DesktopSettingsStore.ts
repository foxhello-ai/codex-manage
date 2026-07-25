import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type DesktopSettings = {
  issueAutoReportEnabled: boolean;
};

const defaultSettings: DesktopSettings = {
  issueAutoReportEnabled: true
};

export class DesktopSettingsStore {
  constructor(private readonly file: string) {}

  load(): DesktopSettings {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DesktopSettings>;
      return {
        issueAutoReportEnabled: typeof parsed.issueAutoReportEnabled === "boolean"
          ? parsed.issueAutoReportEnabled
          : defaultSettings.issueAutoReportEnabled
      };
    } catch {
      return { ...defaultSettings };
    }
  }

  save(settings: DesktopSettings): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}
