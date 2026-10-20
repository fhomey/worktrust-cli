/** Fixed helper programs are covered by the release manifest. No request is evaluated as code. */
export const macKeychainScript = String.raw`
ObjC.import('Foundation'); ObjC.import('Security');
function run() {
  try {
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
    if (!/^[a-f0-9]{64}$/.test(request.id) || request.service !== 'io.worktrust.cli.credentials.v1') throw Error();
    // No reset, default-keychain change, ACL broadening or partition-list modification.
    $.SecKeychainSetUserInteractionAllowed(request.op === 'put');
    var query = $.NSMutableDictionary.alloc.init;
    query.setObjectForKey(ObjC.castRefToObject($.kSecClassGenericPassword), ObjC.castRefToObject($.kSecClass));
    query.setObjectForKey($(request.service), ObjC.castRefToObject($.kSecAttrService));
    query.setObjectForKey($(request.id), ObjC.castRefToObject($.kSecAttrAccount));
    var status, result = Ref();
    if (request.op === 'get') {
      query.setObjectForKey(ObjC.castRefToObject($.kCFBooleanTrue), ObjC.castRefToObject($.kSecReturnData));
      query.setObjectForKey(ObjC.castRefToObject($.kSecMatchLimitOne), ObjC.castRefToObject($.kSecMatchLimit));
      status = $.SecItemCopyMatching(query, result);
      if (status !== 0) throw Error();
      return JSON.stringify({ok: true, value: ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(result[0]), $.NSUTF8StringEncoding))});
    }
    if (request.op === 'put') {
      if (!/^[a-f0-9]{64}$/.test(request.value)) throw Error();
      query.setObjectForKey($(request.value).dataUsingEncoding($.NSUTF8StringEncoding), ObjC.castRefToObject($.kSecValueData));
      query.setObjectForKey($('WorkTrust CLI credential encryption'), ObjC.castRefToObject($.kSecAttrLabel));
      query.setObjectForKey(ObjC.castRefToObject($.kCFBooleanFalse), ObjC.castRefToObject($.kSecAttrSynchronizable));
      status = $.SecItemAdd(query, null);
    } else if (request.op === 'remove') { status = $.SecItemDelete(query); }
    else throw Error();
    if (status !== 0 && !(request.op === 'remove' && status === -25300)) throw Error();
    return '{"ok":true}';
  } catch (_) { return '{"ok":false}'; }
}
`;
export const windowsCredentialScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.id -cnotmatch '^[a-f0-9]{64}$' -or $request.service -cne 'io.worktrust.cli.credentials.v1') { throw 'invalid' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkTrustVault {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref Credential value, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target, uint type, uint flags, out IntPtr value);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredFree")] public static extern void Free(IntPtr value);
}
'@
  $target = $request.service + '/' + $request.id
  if ($request.op -ceq 'get') {
    $pointer = [IntPtr]::Zero
    if (![WorkTrustVault]::Read($target, 1, 0, [ref]$pointer)) { throw 'unavailable' }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][WorkTrustVault+Credential])
      if ($credential.CredentialBlobSize -ne 128) { throw 'invalid' }
      $value = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, 64)
      @{ok=$true; value=$value} | ConvertTo-Json -Compress
    } finally { [WorkTrustVault]::Free($pointer) }
  } elseif ($request.op -ceq 'put') {
    if ($request.value -cnotmatch '^[a-f0-9]{64}$') { throw 'invalid' }
    $credential = New-Object WorkTrustVault+Credential
    $credential.Type=1; $credential.TargetName=$target; $credential.UserName='WorkTrust CLI'
    $credential.Persist=2; $credential.CredentialBlobSize=128
    $credential.CredentialBlob=[Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($request.value)
    try { if (![WorkTrustVault]::Write([ref]$credential, 0)) { throw 'unavailable' } }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($credential.CredentialBlob) }
    '{"ok":true}'
  } elseif ($request.op -ceq 'remove') {
    $removed = [WorkTrustVault]::Delete($target, 1, 0)
    if (!$removed -and [Runtime.InteropServices.Marshal]::GetLastWin32Error() -ne 1168) { throw 'unavailable' }
    '{"ok":true}'
  } else { throw 'invalid' }
} catch { '{"ok":false}'; exit 1 }
`;
