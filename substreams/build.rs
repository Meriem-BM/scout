use std::{env, path::PathBuf};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = PathBuf::from(env::var("OUT_DIR")?);
    substreams_ethereum::Abigen::new("UniswapV3Pool", "abi/pool.json")?
        .generate()?
        .write_to_file(out.join("pool.rs"))?;
    env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path()?);
    prost_build::compile_protos(&["proto/scout.proto"], &["proto"])?;
    println!("cargo:rerun-if-changed=abi/pool.json");
    println!("cargo:rerun-if-changed=proto/scout.proto");
    Ok(())
}
