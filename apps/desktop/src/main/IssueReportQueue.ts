import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PendingIssueReport = {
  id: string;
  kind: "manual" | "auto";
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: string;
  lastError: string | null;
};

type QueuePayload = {
  reports: PendingIssueReport[];
};

export class IssueReportQueue {
  constructor(private readonly file: string) {}

  enqueue(kind: PendingIssueReport["kind"], payload: Record<string, unknown>, lastError: string | null): PendingIssueReport {
    const report: PendingIssueReport = {
      id: randomUUID(),
      kind,
      payload,
      attempts: 0,
      createdAt: new Date().toISOString(),
      lastError
    };
    const reports = this.list();
    reports.push(report);
    this.write(reports.slice(-100));
    return report;
  }

  list(): PendingIssueReport[] {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<QueuePayload>;
      return Array.isArray(parsed.reports) ? parsed.reports.filter(isPendingIssueReport) : [];
    } catch {
      return [];
    }
  }

  count(): number {
    return this.list().length;
  }

  update(report: PendingIssueReport): void {
    const reports = this.list().map((item) => item.id === report.id ? report : item);
    this.write(reports);
  }

  remove(reportId: string): void {
    this.write(this.list().filter((report) => report.id !== reportId));
  }

  private write(reports: PendingIssueReport[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ reports }, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

function isPendingIssueReport(value: unknown): value is PendingIssueReport {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PendingIssueReport>;
  return typeof record.id === "string"
    && (record.kind === "manual" || record.kind === "auto")
    && typeof record.payload === "object"
    && record.payload !== null
    && typeof record.createdAt === "string";
}
