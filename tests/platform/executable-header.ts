/** The first bytes of an executable for `arch`, which is all the check reads. */
export function executableHeader(
  arch: "arm64" | "amd64" | "universal" | "elf-arm64" | "elf-amd64"
): Buffer {
  const header = Buffer.alloc(64);
  if (arch === "universal") {
    header.writeUInt32BE(0xca_fe_ba_be, 0);
  } else if (arch === "elf-arm64" || arch === "elf-amd64") {
    header.writeUInt32BE(0x7f_45_4c_46, 0);
    header.writeUInt16LE(arch === "elf-arm64" ? 0xb7 : 0x3e, 18);
  } else {
    header.writeUInt32LE(0xfe_ed_fa_cf, 0);
    header.writeUInt32LE(arch === "arm64" ? 0x01_00_00_0c : 0x01_00_00_07, 4);
  }
  return header;
}
