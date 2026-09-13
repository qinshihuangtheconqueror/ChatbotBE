import joblib
import numpy as np
from sentence_transformers import SentenceTransformer


class MLRouter:
    def __init__(self, model_path, label_encoder, intent2agent, threshold=0.9):
        
        # classifier
        self.clf = joblib.load(model_path)

        self.le = label_encoder
        self.intent2agent = intent2agent
        self.threshold = threshold

        # embedding model
        self.model_name = "dangvantuan/vietnamese-document-embedding"
        self.embedding_model = self._load_model()

    def _load_model(self):
        return SentenceTransformer(
            self.model_name,
            device='cuda',   #nếu không có GPU → đổi 'cpu'
            trust_remote_code=True
        )

    def route(self, query: str):
        try:
            
            dense = self.embedding_model.encode([query])  # shape (1, dim)

            # ===== PREDICT =====
            if not hasattr(self.clf, "multi_class"):
                self.clf.multi_class = "auto"
            probs = self.clf.predict_proba(dense)[0]
            max_prob = float(np.max(probs))
            best_idx = int(np.argmax(probs))

            # ===== MAP =====
            intent_numeric = self.clf.classes_[best_idx]
            intent = self.le.inverse_transform([intent_numeric])[0]

            agent = self.intent2agent.get(intent, "rag")  # fallback

            return {
                "agent": agent,
                "confidence": max_prob,
                "intent": intent,
                "use_ml": max_prob >= self.threshold
            }

        except Exception as e:
            return {
                "agent": "rag",
                "confidence": 0.0,
                "intent": "error",
                "use_ml": False,
                "error": str(e)
            }