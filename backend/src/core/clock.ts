import { SafetyError } from './errors.js';

export class ClockService {
  public constructor(private readonly maxSkewMs: number) {}

  public now(): Date {
    return new Date();
  }

  public assertRemoteTime(remoteTime: Date, roundTripMs = 0): number {
    const estimatedRemoteNow = remoteTime.getTime() + Math.max(0, roundTripMs) / 2;
    const skewMs = Date.now() - estimatedRemoteNow;
    if (!Number.isFinite(skewMs) || Math.abs(skewMs) > this.maxSkewMs) {
      throw new SafetyError(
        'CLOCK_SKEW_EXCEEDED',
        `Clock skew ${skewMs}ms exceeds ${this.maxSkewMs}ms`,
      );
    }
    return skewMs;
  }
}
