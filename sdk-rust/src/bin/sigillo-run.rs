//! An agent that is already compiled, connected without changing its code: see `sigillo::launcher`.

fn main() {
    std::process::exit(sigillo::launcher::main(std::env::args().skip(1).collect()));
}
