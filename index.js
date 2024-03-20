require('dotenv').config()
const express = require('express');
const app = express();
const cors = require('cors')
const port = process.env.PORT || 3000;
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.PAYMENT_SECRET_KEY)

app.use(cors());
app.use(express.json())

app.get('/', (req, res) => {
    res.send('bistro server is running')
})

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.USER_NAME}:${process.env.PASS}@cluster0.n2wd0zs.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const menuCollection = client.db("bistroDb-1").collection("menu-1");
        const reviewCollection = client.db("bistroDb-1").collection("reviews-1");
        const cartCollection = client.db("bistroDb-1").collection("carts-1");
        const userCollection = client.db("bistroDb-1").collection("users-1");
        const paymentCollection = client.db("bistroDb-1").collection("payments-1");

        //JWT
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
            res.send({ token });
        })

        // middle-wares 
        const verifyToken = (req, res, next) => {
            if (!req.headers.authorization) {
                return res.status(401).send({ message: 'unauthorized access' });
            }
            const token = req.headers.authorization.split(' ')[1];
            jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
                if (err) {
                    return res.status(401).send({ message: 'unauthorized access' })
                }
                req.decoded = decoded;
                next();
            })
        }

        // use verify admin after verifyToken
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email };
            const user = await userCollection.findOne(query);
            const isAdmin = user?.role === 'admin';
            if (!isAdmin) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            next();
        }

        app.get('/menu', async (req, res) => {
            const result = await menuCollection.find().toArray();
            res.send(result)
        })

        app.post('/menu', verifyToken, verifyAdmin, async (req, res) => {
            const newItem = req.body;
            const result = await menuCollection.insertOne(newItem);
            res.send(result)
        })

        app.delete('/menu/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const result = await menuCollection.deleteOne(query);
            res.send(result)
        })


        app.get('/review', async (req, res) => {
            const result = await reviewCollection.find().toArray();
            res.send(result)
        })

        app.post('/carts', async (req, res) => {
            const item = req.body;
            const result = await cartCollection.insertOne(item)
            res.send(result)
        })

        app.get('/carts', async (req, res) => {
            const email = req.query.email;
            if (!email) {
                res.send([])
            }
            else {
                const query = { email: email }
                const result = await cartCollection.find(query).toArray();
                res.send(result)
            }
        })

        app.delete('/carts/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await cartCollection.deleteOne(query);
            res.send(result)
        })

        //post login user in DB one by one
        app.post('/users', async (req, res) => {
            const user = req.body;
            const query = { email: user.email }
            const existingUser = await userCollection.findOne(query);
            if (existingUser) {
                return res.send({ message: 'This user is already logged in' })
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        })

        //get all logged user from DB
        app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
            const result = await userCollection.find().toArray()
            res.send(result)
        })

        //make an user admin
        app.patch('/users/admin/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };

            const updateDoc = {
                $set: {
                    role: 'admin'
                },
            };

            const result = await userCollection.updateOne(filter, updateDoc)
            res.send(result)
        });

        app.get('/users/admin/:email', verifyToken, async (req, res) => {
            const email = req.params.email;

            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' })
            }

            const query = { email: email };
            const user = await userCollection.findOne(query);
            let admin = false;
            if (user) {
                admin = user?.role === 'admin';
            }
            res.send({ admin });
        })

        //delete an user
        app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const result = await userCollection.deleteOne(query)
            res.send(result)
        })

        //payment method...............(>stripe docs a ai code ace)..................................

        app.post('/create-payment-intent', verifyToken, async (req, res) => {
            const { price } = req.body;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types: ['card']
            })
            res.send({ clientSecret: paymentIntent.client_secret })
        })

        //adding payment details to the database.......................................................
        app.post('/payments', verifyToken, async (req, res) => {
            const payment = req.body;
            const insertedResult = await paymentCollection.insertOne(payment);
            //delete item from cart according to the various user who added item to the cart
            const query = { _id: { $in: payment.cartItems.map(id => new ObjectId(id)) } };
            const deleteResult = await cartCollection.deleteMany(query)

            res.send({ insertedResult, deleteResult })
        })

        //admin stats..................................
        app.get('/admin-stats', verifyToken, verifyAdmin, async (req, res) => {
            const users = await userCollection.estimatedDocumentCount();
            const products = await menuCollection.estimatedDocumentCount();
            const orders = await paymentCollection.estimatedDocumentCount();
            const payments = await paymentCollection.find().toArray();
            const revenue = payments.reduce((sum, item) => sum + item.price, 0)
            res.send({ users, products, orders, revenue })
        })

        app.get('/order-status', async (req, res) => {
            const result = await paymentCollection.aggregate([
                {
                    $unwind: "$menuItems"
                },
                {
                    $lookup: {
                        from: "menu-1",
                        localField: "menuItems",
                        foreignField: "_id",
                        as: "menuItemss"
                    }
                },
                {
                    $unwind: "$menuItemss"
                },
                {
                    $group: {
                        _id: "$menuItemss.category",
                        quantity: { $sum: 1 },
                        revenue: { $sum: "$menuItemss.price" }
                    }
                },
                {
                    $project: {
                        _id: 0,
                        category: 1,
                        quantity: 1,
                        revenue: 1
                    }
                }
            ]).toArray()

            res.send(result);
        })

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.listen(port, () => {
    console.log(`server is running on port ${port}`);
})