import { describe, expect, it, vi } from "vitest";
import type { CloudflareAdapter } from "./cloudflare/CloudflareAdapter";
import { ControlError } from "./domain";
import { TunnelProvisioner } from "./provisioner";
import type { ControlStore, ProvisioningJob } from "./store";

const job: ProvisioningJob = {
  id: "job-1",
  jobType: "provision_named_tunnel",
  device: {
    id: "device-1",
    deviceCode: "a83k2m",
    userId: "user-1",
    name: "Mac",
    os: "darwin",
    arch: "arm64",
    clientVersion: "1.0.0",
    codexCliVersion: null,
    originPort: 4310,
    status: "active",
    lastSeenAt: null,
    createdAt: new Date().toISOString()
  },
  tunnel: {
    id: "tunnel-1",
    deviceId: "device-1",
    cloudflareTunnelId: null,
    cloudflareZoneId: "zone-newroot-123456",
    hostname: "d-a83k2m.xmwefun.cn",
    status: "provisioning",
    lastErrorCode: null
  }
};

describe("TunnelProvisioner", () => {
  it("removes Cloudflare resources instead of reactivating a device blocked during provisioning", async () => {
    const store = {
      claimProvisioningJob: vi.fn(async () => job),
      completeProvisioningJob: vi.fn(async () => false),
      completeRevocationJob: vi.fn(async () => undefined),
      convertProvisioningJobToRevocation: vi.fn(async () => undefined),
      retryProvisioningJob: vi.fn(async () => undefined),
      getSystemConfig: vi.fn(async () => ({
        publicApiBaseUrl: "https://codex-api.newroot.cn",
        desktopUpdateFeedUrl: "https://codex-api.newroot.cn/updates/stable",
        deviceDomain: "newroot.cn",
        managedDomainSuffixes: ["newroot.cn"],
        adminOrigins: ["https://codex-admin.newroot.cn"],
        desktopConfigTtlSeconds: 300,
        cloudflareZoneId: "zone-newroot-123456",
        updatedAt: "2026-07-31T00:00:00.000Z",
        updatedByAdminId: "admin-1"
      }))
    } as unknown as ControlStore;
    const cloudflare = {
      createTunnel: vi.fn(async () => ({ id: "cf-1" })),
      configurePublicHostname: vi.fn(async () => undefined),
      createDnsRoute: vi.fn(async () => undefined),
      deletePublishedTunnel: vi.fn(async () => undefined)
    } as unknown as CloudflareAdapter;

    await expect(new TunnelProvisioner(store, cloudflare).runOnce()).resolves.toBe(true);

    expect(cloudflare.createDnsRoute).toHaveBeenCalledWith(job.tunnel.hostname, "cf-1", "zone-newroot-123456");
    expect(cloudflare.deletePublishedTunnel).toHaveBeenCalledWith("cf-1", job.tunnel.hostname, "zone-newroot-123456");
    expect(store.completeRevocationJob).toHaveBeenCalledWith(job.id, job.tunnel.id);
    expect(store.retryProvisioningJob).not.toHaveBeenCalled();
  });

  it("converts a failed cleanup into an idempotent revocation job", async () => {
    const store = {
      claimProvisioningJob: vi.fn(async () => job),
      completeProvisioningJob: vi.fn(async () => false),
      completeRevocationJob: vi.fn(async () => undefined),
      convertProvisioningJobToRevocation: vi.fn(async () => undefined),
      retryProvisioningJob: vi.fn(async () => undefined),
      getSystemConfig: vi.fn(async () => null)
    } as unknown as ControlStore;
    const cloudflare = {
      createTunnel: vi.fn(async () => ({ id: "cf-1" })),
      configurePublicHostname: vi.fn(async () => undefined),
      createDnsRoute: vi.fn(async () => undefined),
      deletePublishedTunnel: vi.fn(async () => {
        throw new ControlError("CLOUDFLARE_RATE_LIMITED", "rate limited", 502);
      })
    } as unknown as CloudflareAdapter;

    await new TunnelProvisioner(store, cloudflare).runOnce();

    expect(store.convertProvisioningJobToRevocation).toHaveBeenCalledWith(
      job.id,
      job.tunnel.id,
      "cf-1",
      "CLOUDFLARE_RATE_LIMITED",
      "rate limited"
    );
  });
});
