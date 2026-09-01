type NativeScriptResult = Readonly<{
  runtime: string;
  nativeTypeScript: true;
}>;

const result: NativeScriptResult = {
  runtime: process.version,
  nativeTypeScript: true,
};

console.log(JSON.stringify(result));
