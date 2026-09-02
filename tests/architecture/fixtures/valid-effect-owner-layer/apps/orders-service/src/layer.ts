import {Effect} from "effect";
import {OrderService} from "./service.js";

export const layer = Effect.succeed(OrderService);
