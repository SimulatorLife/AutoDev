import { LaunchdClient } from "../platform/macos/launchd.ts";

export interface ManagedService {
  label: string;
  plist: string;
}
export interface ServiceLifecycle {
  bootstrap(service: ManagedService): void;
  restart(service: ManagedService): void;
  isHealthy(service: ManagedService): boolean;
}

export function createMacosServiceLifecycle(
  client = new LaunchdClient()
): ServiceLifecycle {
  return {
    bootstrap(service) {
      if (client.isLoaded(service.label)) client.bootout(service.label);
      client.bootstrap(service.plist);
    },
    restart(service) {
      if (client.isLoaded(service.label)) client.kickstart(service.label);
      else client.bootstrap(service.plist);
    },
    isHealthy(service) {
      return (
        client.isLoaded(service.label) &&
        client.print(service.label).includes(service.label)
      );
    }
  };
}
