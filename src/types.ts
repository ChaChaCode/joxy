export interface Profile {
  id: string; name: string; address: string; port: number;
  countryCode?: string | null;
  transport: string; security: string; flow: string; fragment: boolean; sourceId: string;
  lastTest: null | { status: 'checking' | 'ok' | 'error'; latency?: number; message?: string; checkedAt?: string };
}
export interface Settings {
  mode: 'system' | 'tun' | 'local'; systemProxy: boolean; autoFallback: boolean; timeout: number; interface: string; closeToTray: boolean;
  dnsProvider: 'cloudflare' | 'google'; bypassLan: boolean; bypassRu?: boolean; directRules: string[]; tunMtu: number; tunIpv6: 'block' | 'tunnel'; tunDnsProtection: boolean; killSwitch: boolean; autoConnect?: boolean; theme?: 'system' | 'light' | 'dark';
}
export interface Source {
  id: string; label: string; host: string; updatedAt: string; count: number; remote?: boolean;
  usage?: { upload?: number; download?: number; total?: number; expire?: number } | null;
  announcement?: string | null; supportUrl?: string | null; websiteUrl?: string | null;
}
export interface State {
  version: string; profiles: Profile[];
  sources: Source[];
  selectedId: string; settings: Settings; checking: boolean;
  connection: { phase: 'idle' | 'connecting' | 'connected' | 'error'; profileId: string | null; since: string | null; exitIP: string | null; latency: number | null; systemProxy: boolean; mode?: Settings['mode']; error?: string; errorCode?: 'vpn-conflict' | 'wfp-blocked'; ports?: { http: number; socks: number } };
  update?: { status: 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'ready' | 'error'; version: string | null; progress: number; error: string | null; checkedAt: string | null } | null;
  stats: { down: number; up: number; downRate: number; upRate: number; history: { down: number; up: number }[] };
  logs: { id: string; time: string; level: 'info' | 'warning' | 'error'; message: string }[];
  environment: { interface: string; interfaces: string[]; tunActive: boolean; windows: boolean; detectionFailed?: boolean; elevated?: boolean; recoveryRequired?: boolean; foreignTunnels?: { name: string; routeCount: number }[] };
  core: { ready: boolean; version: string; error: string | null; tunReady?: boolean; tunError?: string };
  killSwitch?: { available: boolean; armed: boolean };
}
export interface Bridge {
  state(): Promise<State>;
  import(value: string): Promise<{ count: number; rejected: string[] }>;
  importFile(): Promise<{ count: number; rejected: string[] } | null>;
  refresh(id?: string): Promise<void>; select(id: string): Promise<void>; share(id: string): Promise<void>; removeProfile(id: string): Promise<void>; removeSource(id: string): Promise<void>;
  openProvider(id: string, kind: 'supportUrl' | 'websiteUrl'): Promise<void>;
  connect(): Promise<void>; disconnect(): Promise<void>; test(id?: string): Promise<void>; testProfile(id: string): Promise<void>;
  settings(patch: Partial<Settings>): Promise<void>; environment(): Promise<State['environment']>;
  elevate(patch: Partial<Settings>, options?: { connect?: boolean }): Promise<void>;
  exportDiagnostics(): Promise<boolean>; checkUpdate(): Promise<State['update']>; installUpdate(): Promise<void>; minimize(): Promise<void>; close(): Promise<void>;
  onState(callback: (state: State) => void): () => void;
}
declare global { interface Window { joxy?: Bridge } }
