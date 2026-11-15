// Единые пути операторского состояния: никаких скрытых каталогов в коде.
// Каждый путь задаётся переменной окружения, значение по умолчанию сохраняет
// совместимость с уже развёрнутыми юнитами и релизами.

import { homedir } from "node:os";
import { join, resolve } from "node:path";

function declared(value, name) {
  if (value === undefined || value.length === 0) return undefined;
  if (!value.startsWith("/"))
    throw new Error(`${name}: требуется абсолютный путь`);
  return resolve(value);
}

/** Корень состояния развёртывания: releases, controllers, state, overrides. */
export function deploymentStateRoot(env = process.env, home = homedir()) {
  return (
    declared(env.COFFEE_PLATFORM_STATE, "COFFEE_PLATFORM_STATE") ??
    join(home, "coffee-platform")
  );
}

/** Каталог релизов локального развёртывания. */
export function deploymentReleasesRoot(env = process.env, home = homedir()) {
  return join(deploymentStateRoot(env, home), "runtime/releases");
}

/** Каталог состояния локального развёртывания. */
export function deploymentRuntimeStateRoot(
  env = process.env,
  home = homedir(),
) {
  return join(deploymentStateRoot(env, home), "runtime/state");
}

/** Каталог юнитов systemd пользователя. */
export function systemdUserUnitRoot(env = process.env, home = homedir()) {
  return (
    declared(env.COFFEE_SYSTEMD_USER_DIR, "COFFEE_SYSTEMD_USER_DIR") ??
    join(home, ".config/systemd/user")
  );
}

/** Каталог релизов observability. */
export function observabilityReleasesRoot(env = process.env, home = homedir()) {
  return (
    declared(
      env.COFFEE_OBSERVABILITY_RELEASES,
      "COFFEE_OBSERVABILITY_RELEASES",
    ) ?? join(home, ".local/share/coffee-platform/observability/releases")
  );
}
