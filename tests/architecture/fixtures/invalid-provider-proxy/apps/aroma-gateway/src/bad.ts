export const proxy = (request: Request): Promise<Response> =>
  Promise.resolve(new Response(request.body));
