function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export async function createMigrationDatabase(
  database,
  resources,
  create,
  inspectOutcome,
) {
  const resource = { database, state: "create-pending" };
  resources.push(resource);
  try {
    await create();
    resource.state = "created-acknowledged";
    return resource;
  } catch (error) {
    try {
      const outcome = await inspectOutcome();
      resource.inspection = outcome;
    } catch {
      resource.inspection = null;
    }
    resource.state = "ambiguous";
    throw error;
  }
}

export async function cleanupMigrationDatabases(resources, removeOwned) {
  const removed = [];
  const retained = [];
  for (const resource of [...resources].reverse()) {
    if (resource.state !== "created-acknowledged") {
      retained.push(resource.database.name);
      continue;
    }
    try {
      await removeOwned(resource.database);
      removed.push(resource.database.name);
    } catch {
      retained.push(resource.database.name);
    }
  }
  return {
    verified: retained.length === 0,
    removed: sorted(removed),
    retained: sorted(retained),
  };
}
