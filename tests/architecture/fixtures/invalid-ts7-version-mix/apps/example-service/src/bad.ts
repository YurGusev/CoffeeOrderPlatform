declare const order: OrderVersion;
declare const projection: ProjectionVersion;

export const same = order === projection;
