use std::env;
use std::fs;

fn main() {
    let path = env::args().nth(1).expect("usage: wordcount <file>");
    let text = fs::read_to_string(path).expect("cannot read file");
    println!("{}", text.split_whitespace().count());
}
