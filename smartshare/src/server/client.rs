use smartshare::protocol::msg::Message;
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Client {
    id: usize,
    sender: mpsc::Sender<Message>,
}

impl Client {
    pub fn new(id: usize, sender: mpsc::Sender<Message>) -> Self {
        Self { id, sender }
    }

    pub async fn send(&self, message: Message) -> anyhow::Result<()> {
        self.sender.send(message).await.map_err(Into::into)
    }

    pub fn id(&self) -> usize {
        self.id
    }
}
