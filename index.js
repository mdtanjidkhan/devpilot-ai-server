const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  try {
    await client.connect();
    
    const db = client.db("devpilot");
    const projectsCollection = db.collection("projects");

    console.log(" 🟢 Successfully connected to MongoDB and initialized collections!");
    app.post('/api/generate-blueprint', async (req, res) => {
      try {
        const { projectName, category, description, targetUsers, selectedTech } = req.body;

        if (!projectName || !category || !description || !targetUsers) {
          return res.status(400).json({ success: false, error: "Missing required fields" });
        }

        const prompt = `
          You are an expert Software Architect. Analyze the following project requirements and generate a detailed production-ready software blueprint.
          
          Project Details:
          - Name: ${projectName}
          - Category: ${category}
          - Description: ${description}
          - Target Users: ${targetUsers}
          - Preferred Tech Stack: ${selectedTech ? selectedTech.join(', ') : 'Not specified'}

          CRITICAL JSON STRUCTURE REQUIREMENT: 
          You must return a raw JSON object matching the schema below. 
          Do NOT wrap the JSON inside markdown blocks like \`\`\`json or \`\`\`.
          Inside the "fileStructure" and "schemaDesign" fields, provide the code or layout directly as plain text string without using any markdown code blocks (\`\`\`).

          Expected JSON Schema:
          {
            "overview": "Detailed architectural overview...",
            "modules": [
              "Module 1 description",
              "Module 2 description"
            ],
            "fileStructure": "Plain text directory tree representation here (NO markdown blocks)",
            "schemaDesign": "Plain text database schema layout or code here (NO markdown blocks)"
          }
        `;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: {
            responseMimeType: "application/json"
          }
        });

        const aiResponseText = response.text.trim();
        
        let blueprintData;
        try {
          blueprintData = JSON.parse(aiResponseText);
        } catch (jsonErr) {
          console.error("Failed to parse AI response as JSON:", aiResponseText);
          return res.status(500).json({ success: false, error: "AI response formatting error. Please try again." });
        }

        const newProject = {
          projectName,
          category,
          description,
          targetUsers,
          selectedTech: selectedTech || [],
          blueprint: blueprintData,
          createdAt: new Date()
        };

        const result = await projectsCollection.insertOne(newProject);
        console.log("Project blueprint saved with ID:", result.insertedId);
        res.status(201).json({
          success: true,
          message: "Project blueprint generated and saved successfully",
          projectId: result.insertedId
        });

      } catch (error) {
        console.error("Error in /api/generate-blueprint:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    app.get('/api/projects/:id', async (req, res) => {
      try {
        const id = req.params.id;
  
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, error: "Invalid Project ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const project = await projectsCollection.findOne(query);

        if (!project) {
          return res.status(404).json({ success: false, error: "Project not found" });
        }

        res.status(200).json({ success: true, project });
      } catch (error) {
        console.error("Error in fetching project:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

   // patch endpoint to update a specific section of the blueprint
app.patch('/api/projects/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const { section, value } = req.body; 
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: "Invalid project ID format" });
        }
        const updateField = {};
        updateField[`blueprint.${section}`] = value;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: updateField
        };

        const result = await projectsCollection.updateOne(filter, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).json({ success: false, message: "Project not found" });
        }

        res.json({ success: true, message: "Section updated successfully" });
      } catch (error) {
        console.error("Error updating project section:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
// delete endpoint to remove a project by ID
    app.delete('/api/projects/:id', async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: "Invalid project ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const result = await projectsCollection.deleteOne(query);

        if (result.deletedCount === 1) {
          res.json({ success: true, message: "Project deleted successfully from database" });
        } else {
          res.status(404).json({ success: false, message: "Project not found" });
        }
      } catch (error) {
        console.error("Error deleting project:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // dashboard/projects endpoint to fetch all projects with pagination

 app.get('/api/projects', async (req, res) => {
  try {
    const { search } = req.query; 
    let query = {};

    if (search) {
      query = {
        $or: [
          { projectName: { $regex: search, $options: 'i' } }, 
          { category: { $regex: search, $options: 'i' } }
        ]
      };
    }

    const projects = await projectsCollection.find(query).sort({ _id: -1 }).toArray();
    res.json({ success: true, projects });
  } catch (error) {
    console.error("Error fetching projects with regex search:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


    // text upore

  } catch (err) {
    console.error("MongoDB Initialization Error:", err);
  }

}



run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('DevPilot AI Server is Running...');
});


app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});