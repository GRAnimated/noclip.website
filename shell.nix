{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_20
    nodePackages.pnpm
    rustc
    cargo
    wasm-pack
    pkg-config
    openssl
    lld
  ];
  
  shellHook = ''
    export COREPACK_HOME="$PWD/.corepack"
    mkdir -p $COREPACK_HOME
  '';
}
