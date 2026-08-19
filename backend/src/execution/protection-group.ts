export type ProtectionLegRole = 'PARENT' | 'TAKE_PROFIT' | 'STOP_LOSS';
export type ProtectionLegState =
  'DORMANT' | 'ACTIVE' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCEL_PENDING' | 'CANCELED' | 'UNKNOWN';

export interface ProtectionLeg {
  readonly id: string;
  readonly brokerOrderId?: string;
  readonly role: ProtectionLegRole;
  readonly state: ProtectionLegState;
  readonly filledQuantity: string;
}

export interface ProtectionAction {
  readonly type: 'ACTIVATE_CHILDREN' | 'CANCEL_SIBLING' | 'RECONCILE' | 'BLOCK_DUPLICATE';
  readonly legIds: readonly string[];
  readonly reason: string;
}

export class ProtectionGroup {
  private legsValue: ProtectionLeg[];

  public constructor(
    public readonly id: string,
    public readonly symbol: string,
    public readonly positionBindingId: string,
    legs: readonly ProtectionLeg[],
  ) {
    if (legs.filter((leg) => leg.role === 'PARENT').length !== 1)
      throw new Error('Protection group requires exactly one parent');
    if (new Set(legs.map((leg) => leg.id)).size !== legs.length)
      throw new Error('Protection leg IDs must be unique');
    this.legsValue = [...legs];
  }

  public get legs(): readonly ProtectionLeg[] {
    return [...this.legsValue];
  }

  public update(
    legId: string,
    state: ProtectionLegState,
    filledQuantity: string,
  ): readonly ProtectionAction[] {
    const index = this.legsValue.findIndex((leg) => leg.id === legId);
    const leg = this.legsValue[index];
    if (leg === undefined)
      return [{ type: 'RECONCILE', legIds: [legId], reason: 'Unknown leg update' }];
    this.legsValue[index] = { ...leg, state, filledQuantity };
    if (leg.role === 'PARENT' && ['PARTIALLY_FILLED', 'FILLED'].includes(state)) {
      const children = this.legsValue.filter((candidate) => candidate.role !== 'PARENT');
      return [
        {
          type: 'ACTIVATE_CHILDREN',
          legIds: children.map((child) => child.id),
          reason: 'Parent fill changed protected quantity',
        },
      ];
    }
    if (leg.role !== 'PARENT' && state === 'FILLED') {
      const siblings = this.legsValue.filter(
        (candidate) => candidate.role !== 'PARENT' && candidate.id !== leg.id,
      );
      return [
        {
          type: 'CANCEL_SIBLING',
          legIds: siblings.map((sibling) => sibling.id),
          reason: 'OCO race protection: one exit leg filled',
        },
        {
          type: 'RECONCILE',
          legIds: this.legsValue.map((candidate) => candidate.id),
          reason: 'Confirm the OCO set after a fill/cancel race',
        },
      ];
    }
    return [];
  }

  public recoveryActions(): readonly ProtectionAction[] {
    const children = this.legsValue.filter((leg) => leg.role !== 'PARENT');
    if (children.length < 2 || children.some((leg) => leg.state === 'UNKNOWN'))
      return [
        {
          type: 'RECONCILE',
          legIds: this.legsValue.map((leg) => leg.id),
          reason: children.length < 2 ? 'Incomplete bracket' : 'Unknown protection leg state',
        },
      ];
    return [];
  }
}
