import { PushStream, Cancel, EmitType, transfer } from "collection-query";
import {
  create,
  filter,
  scan,
  map,
  take,
  EmitForm,
} from "collection-query/push";

export function throttle<T>(
  t: number,
  option = { leading: true, trailing: false }
): (s: PushStream<T>) => PushStream<T> {
  const { leading, trailing } = option;
  if (trailing) {
    return throttleWithTrailing(t, leading);
  } else {
    if (leading) {
      return throttleLeading(t);
    } else {
      return take<any>(0);
    }
  }
}

class Throttle<T> {
  constructor(span: number) {
    this.span = span;
    this._sleep = true;
  }

  async cycle() {
    this._sleep = false;
    this._catchLeading = false;
    this._catchTrailing = false;
    await this.delay();
    this._sleep = true;
  }

  leading() {
    this._catchLeading = true;
  }

  pushTrailing(x: T) {
    this._catchTrailing = true;
    this._trailing = x;
  }

  popTrailing() {
    const x = this._trailing;
    this._trailing = null!;
    return x;
  }

  get sleep() {
    return this._sleep;
  }

  get catchLeading() {
    return this._catchLeading;
  }

  get catchTrailing() {
    return this._catchTrailing;
  }

  private delay() {
    return new Promise((r) => setTimeout(r, this.span));
  }

  private span: number;
  private _sleep: boolean;
  private _catchLeading!: boolean;
  private _catchTrailing!: boolean;
  private _trailing!: T;
}

function throttleWithTrailing<T>(
  span: number,
  leading: boolean
): (s: PushStream<T>) => PushStream<T> {
  if (span <= 0) {
    return (s) => s;
  }

  return function (s) {
    return function (receiver, expose): Cancel {
      let relay_emit!: EmitForm<T>;
      let _source_cancel: Cancel;
      const source_cancel = function () {
        _source_cancel();
      };

      const relay_emitter = create<T>((emit) => {
        relay_emit = emit;
        return source_cancel;
      });

      const cancel = relay_emitter(receiver, (c) => {
        if (expose) {
          expose(c);
        }
      });

      const throttle = new Throttle<T>(span);

      s(
        (t, x?) => {
          switch (t) {
            case EmitType.Next:
              if (throttle.sleep) {
                (async () => {
                  while (true) {
                    await throttle.cycle();
                    if (throttle.catchTrailing) {
                      relay_emit(t, throttle.popTrailing());
                    } else if (!throttle.catchLeading) {
                      return;
                    }
                  }
                })();

                if (leading) {
                  throttle.leading();
                  relay_emit(t, x);
                } else {
                  throttle.pushTrailing(x);
                }
              } else {
                if (leading && !throttle.catchLeading) {
                  throttle.leading();
                  relay_emit(t, x);
                } else {
                  throttle.pushTrailing(x);
                }
              }
              break;
            case EmitType.Complete:
              if (!throttle.sleep && throttle.catchTrailing) {
                relay_emit(EmitType.Next, throttle.popTrailing());
              }
              relay_emit(t);
              break;
            case EmitType.Error:
              relay_emit(t, x);
              break;
          }
        },
        (c) => (_source_cancel = c)
      );

      return cancel;
    };
  };
}

function throttleLeading<T>(span: number) {
  type Item = [{ until: number }, boolean, T];
  return function (s: PushStream<T>): PushStream<T> {
    return transfer(s, [
      scan<T, Item>(
        ([context], x) => {
          const now = performance.now();
          if (context.until < now) {
            let until = context.until + span;
            if (until < now) {
              until = now + span;
            }
            context.until = until;
            return [context, true, x];
          } else {
            return [context, false, x];
          }
        },
        [{ until: 0 }] as any
      ),
      filter<Item>(([, test]) => test),
      map(([, , x]: Item) => x),
    ]);
  };
}
