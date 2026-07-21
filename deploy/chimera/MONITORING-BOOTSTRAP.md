# Chimera monitoring bootstrap

The attested server release deploys only the OCI image and does not modify host-level forced commands, sudoers, or systemd units.

Generate a dedicated Ed25519 key pair for the status-only identity. Before enabling the scheduled `Chimera Independent External Monitor` workflow for the first time, check out the exact reviewed production commit on the host and run:

```bash
sudo ./deploy/chimera/install-monitoring.sh /root/chimera-status-monitor.pub
```

The installer reads only the new public key and provisions `chimera-status-monitor`; it never reads a private key or changes the server deployment key. The status forced command accepts only `status-server`, validates sudoers before activation, starts the disk check once, enables the six-hour timer, and returns only `ok` or a failure without filesystem metrics.

Configure the `production-monitor` GitHub Environment with `CHIMERA_STATUS_MONITOR_SSH_KEY` and `CHIMERA_STATUS_MONITOR_HOST_KEY`. Do not place a server deployment key in this Environment.
