from fastapi import FastAPI
from pydantic import BaseModel

from ml_router import MLRouter

app = FastAPI()


intent2agent = {
    "schedule": "schedule",
    "academic": "academic",
    "company_topics": "company_topics",
    "faculty": "faculty",
}


router = MLRouter(
    model_path="best_Logistic_Regression.pkl",
    label_encoder="label_encoder.pkl",
    intent2agent=intent2agent,
    threshold=0.90
)


class RouteRequest(BaseModel):
    query: str


@app.get("/health")
async def health():
    return {
        "status": "ok"
    }


@app.post("/route")
async def route(req: RouteRequest):

    result = router.route(req.query)

    return result

