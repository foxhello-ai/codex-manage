import { ControlError } from "./domain";
import type { ControlStore, ProvisioningJob } from "./store";
import type { CloudflareAdapter } from "./cloudflare/CloudflareAdapter";

export class TunnelProvisioner {
  constructor(
    private readonly store: ControlStore,
    private readonly cloudflare: CloudflareAdapter
  ) {}

  async runOnce(): Promise<boolean> {
    const job = await this.store.claimProvisioningJob();
    if (!job) return false;

    try {
      if (job.jobType === "provision_named_tunnel") {
        await this.provision(job);
      } else {
        await this.revoke(job);
      }
      return true;
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "TUNNEL_PROVISIONING_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await this.store.retryProvisioningJob(job.id, job.tunnel.id, code, message);
      return true;
    }
  }

  private async provision(job: ProvisioningJob): Promise<void> {
    const external = job.tunnel.cloudflareTunnelId
      ? { id: job.tunnel.cloudflareTunnelId }
      : await this.cloudflare.createTunnel(`codex-device-${job.device.deviceCode}`);
    await this.cloudflare.configurePublicHostname(external.id, job.tunnel.hostname, job.device.originPort);
    await this.cloudflare.createDnsRoute(job.tunnel.hostname, external.id);
    const activated = await this.store.completeProvisioningJob(job.id, job.tunnel.id, external.id);
    if (activated) return;

    // The user or device may have been blocked while Cloudflare resources
    // were being created. Never reactivate that tunnel; clean it up instead.
    try {
      await this.cloudflare.deletePublishedTunnel(external.id, job.tunnel.hostname);
      await this.store.completeRevocationJob(job.id, job.tunnel.id);
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "TUNNEL_REVOCATION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      await this.store.convertProvisioningJobToRevocation(
        job.id,
        job.tunnel.id,
        external.id,
        code,
        message
      );
    }
  }

  private async revoke(job: ProvisioningJob): Promise<void> {
    await this.cloudflare.deletePublishedTunnel(job.tunnel.cloudflareTunnelId, job.tunnel.hostname);
    await this.store.completeRevocationJob(job.id, job.tunnel.id);
  }
}
