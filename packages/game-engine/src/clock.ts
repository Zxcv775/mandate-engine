export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  private readonly instant: Date;

  constructor(value: string | Date) {
    this.instant = new Date(value);
    if (Number.isNaN(this.instant.getTime())) {
      throw new Error("FixedClock 需要合法时间");
    }
  }

  now(): Date {
    return new Date(this.instant);
  }
}
