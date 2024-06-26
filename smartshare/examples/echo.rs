use futures::SinkExt;
use smartshare::protocol::msg::MessageServer;
use smartshare::protocol::{message_sink, message_stream};

#[tokio::main]
async fn main() {
    let mut sink = message_sink::<MessageServer, _>(tokio::io::stdout());
    let mut stream = message_stream(tokio::io::stdin());
    sink.send_all(&mut stream).await.unwrap();
}
