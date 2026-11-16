import express, { application } from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors());

const client = new MongoClient(
  `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-q06qa1s-shard-00-00.in0bbrm.mongodb.net:27017,ac-q06qa1s-shard-00-01.in0bbrm.mongodb.net:27017,ac-q06qa1s-shard-00-02.in0bbrm.mongodb.net:27017/?ssl=true&replicaSet=atlas-say8by-shard-0&authSource=admin`,
);

// Connect To MongoDB Function
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

// কানেক্ট করার জন্য কল করতে হবে।
const connectedClient = await connectToMongoDB();
const database = connectedClient.db("hireloop-db");
const users = database.collection("user");
const jobs = database.collection("allJobs");
const applications = database.collection("applications");
const payments = database.collection("payments");

app.get("/", (req, res) => {
  res.send({ message: "Hireloop is Looping!" });
});

// Users Related API's
app.get("/users", async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/users/:id/premium", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await users.findOne(query, { projection: { premium: 1 } });
  res.send(result);
});

// Job Related API
app.get("/jobs", async (req, res) => {
  const query = {};
  console.log(req.query);
  if (req.query) {
    if (req.query.category) {
      query.category = req.query.category;
    }
    if (req.query.jobType) {
      // mongodb তে বড় হাতের থাকার কারণে এখানে  নিচের মত কেস-ইনসেনসিটিভ রেজেক্স দেওয়া হল।
      query.jobType = { $regex: new RegExp(`^${req.query.jobType}$`, "i") };
    }
    if (req.query.recruiterId) {
      query.recruiterId = req.query.recruiterId;
    }

    // case sensative check.
    if (req.query.search && req.query.search.trim() !== "") {
      // Escape special regex characters to prevent regex injection/errors
      const escapedSearch = req.query.search
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      query.$or = [
        { title: { $regex: escapedSearch, $options: "i" } },
        { responsibilities: { $regex: escapedSearch, $options: "i" } },
        { qualifications: { $regex: escapedSearch, $options: "i" } },
      ];
    }
  }

  const cursor = jobs.find(query);
  const result = await cursor.toArray();
  res.send(result);
});

// Job Post API
app.post("/jobs", async (req, res) => {
  const job = req.body;
  const result = await jobs.insertOne(job);
  res.send(result);
});

// Get single Job API
app.get("/jobs/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await jobs.findOne(query);
  res.send(result);
});

// Job Application API
app.post("/applications", async (req, res) => {
  const application = req.body;
  const result = await applications.insertOne(application);
  res.send(result);
});

// Applications Updated
app.patch("/applications/:id", async (req, res) => {
  const { id } = req.params;
  const query = { _id: new ObjectId(id) };
  const updatedDoc = {
    $set: {
      status: req.body.status,
    },
  };
  const result = await applications.updateOne(query, updatedDoc);
  res.send(result);
});

app.get("/applications", async (req, res) => {
  const query = {};
  if (req.query.applicantId) {
    query.userId = req.query.applicantId;
  }
  if (req.query.jobId) {
    query.jobId = req.query.jobId;
  }
  const cursor = applications.find(query);
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/applications/count", async (req, res) => {
  const query = {};
  if (req.query.applicantId) {
    query.userId = req.query.applicantId;
  }
  if (req.query.jobId) {
    query.jobId = req.query.jobId;
  }
  const result = await applications.countDocuments(query);
  res.send({ count: result });
});

// Delete specific Job API
app.delete("/jobs/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await jobs.deleteOne(query);
  res.send(result);
});

// Payment relatde API's
app.post("/payments/checkout-verify", async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.send({ success: false, message: "session Id is required." });
  }

  const { status, customer_email, metadata, payment_intent, payment_status } =
    await stripe.checkout.sessions.retrieve(sessionId);

  // 1. এটা কি নতুন কোন সেশন কি না তা চেক করবে।
  // 2. চেক করবে যে সেশন আইডিটাকি বর্তমান ইউজারের কি না।
  // 3. সেশনআইডিটি পেমেন্ট কালেকশননে ডুকানো হবে।
  // 4. প্রিমিয়াম িইউজার হিসেবে আপডেট করা হবে।

  if (status === "complete" && payment_status === "paid") {
    const sessionQuery = { sessionId };
    const existingPayment = await payments.findOne(sessionQuery);
    if (existingPayment) {
      return res.send({ success: false, message: "Payment already Verified" });
    }

    const payment = {
      sessionId,
      status,
      payment_status,
      customer_email,
      userId: metadata.userId,
      payment_date: new Date(),
      payment_intent,
    };
    const result = await payments.insertOne(payment);

    // Update The user Table
    const query = { _id: new ObjectId(metadata.userId) };

    // const updatedDoc = {
    //   $set: {
    //     premium: true,
    //   },
    // };
    const updateResult = await users.updateOne(
      { _id: new ObjectId(metadata.userId) },
      {
        $set: {
          premium: true,
        },
      },
    );
    res.send({ success: true, result, updateResult });
  }
  res.send({ success: false, message: "Payment Verification failed!" });
  return;
});

app.listen(port, () => {
  console.log(`This Port is currently Running on ${port}`);
});
