export type ApplicationSessionToken = Readonly<{
  actorRef: string;
  generation: number;
}>;

let actorRef: string | undefined;
let generation = 0;

export function currentApplicationActor(): string | undefined {
  return actorRef;
}

export function setApplicationSession(nextActorRef: string | undefined): number {
  if (actorRef !== nextActorRef) {
    actorRef = nextActorRef;
    generation += 1;
  }
  return generation;
}

export function captureApplicationSession(expectedActorRef: string): ApplicationSessionToken {
  if (actorRef !== expectedActorRef) throw new Error("Сессия оператора изменилась");
  return { actorRef: expectedActorRef, generation };
}

export function assertApplicationSession(token: ApplicationSessionToken): void {
  if (actorRef !== token.actorRef || generation !== token.generation) {
    throw new Error("Ответ относится к предыдущей сессии оператора");
  }
}
